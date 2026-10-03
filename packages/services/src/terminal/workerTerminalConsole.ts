const consoleClient = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public static class ZaicodeWorkerConsole {
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool ReadConsoleW(IntPtr handle, [Out] char[] text, uint length, out uint read, IntPtr reserved);

  public static async Task<int> Run(string pipe, string token, string lease) {
    const string prefix = @"\\.\pipe\";
    if (!pipe.StartsWith(prefix, StringComparison.Ordinal)) throw new IOException("Invalid worker pipe");
    IntPtr inputHandle = GetStdHandle(-10), outputHandle = GetStdHandle(-11);
    uint inputMode, outputMode;
    if (!GetConsoleMode(inputHandle, out inputMode) || !GetConsoleMode(outputHandle, out outputMode))
      throw new IOException("PowerShell console is not interactive");
    Encoding inputEncoding = Console.InputEncoding, outputEncoding = Console.OutputEncoding;
    var utf8 = new UTF8Encoding(false);
    Console.InputEncoding = utf8;
    Console.OutputEncoding = utf8;
    // GUI Electron 没有继承 console stdio；PowerShell 自己使用原生 VT 输入/输出，保留原 PTY 的交互字节。
    if (!SetConsoleMode(inputHandle, (inputMode & ~0x47u) | 0x280u) ||
        !SetConsoleMode(outputHandle, outputMode | 4u))
      throw new IOException("Could not enable terminal console input/output");
    using (var socket = new NamedPipeClientStream(".", pipe.Substring(prefix.Length), PipeDirection.InOut, PipeOptions.Asynchronous)) {
      int done = 0;
      var active = new ManualResetEventSlim(false);
      var serial = new SemaphoreSlim(1, 1);
      var sendJson = new JavaScriptSerializer();
      var receiveJson = new JavaScriptSerializer();
      try {
        await socket.ConnectAsync(5000).ConfigureAwait(false);
        var reader = new StreamReader(socket, utf8, false, 65536, true);
        var writer = new StreamWriter(socket, utf8, 65536, true) { AutoFlush = true };
        Func<object, Task> send = async frame => {
          await serial.WaitAsync().ConfigureAwait(false);
          try { await writer.WriteLineAsync(sendJson.Serialize(frame)).ConfigureAwait(false); }
          finally { serial.Release(); }
        };
        Stream output = Console.OpenStandardOutput();
        var input = new Thread(() => {
          try {
            active.Wait();
            var chars = new char[4096];
            string pending = "";
            while (Volatile.Read(ref done) == 0) {
              uint length;
              // Console 的 byte stream 会丢失非 ASCII 按键；W API 读取原始 Unicode，JSON 传输再编码为 UTF-8。
              if (!ReadConsoleW(inputHandle, chars, (uint)chars.Length, out length, IntPtr.Zero))
                throw new IOException("Could not read terminal console input");
              if (length == 0) break;
              string data = pending + new string(chars, 0, (int)length);
              pending = "";
              // W API 可以在两个读取之间切开 surrogate pair；完整字符才进入 UTF-8 wire，避免 emoji 被拆掉。
              if (Char.IsHighSurrogate(data[data.Length - 1])) {
                pending = data.Substring(data.Length - 1);
                data = data.Substring(0, data.Length - 1);
              }
              if (data.Length > 0) send(new { type = "write", data }).GetAwaiter().GetResult();
            }
          } catch { socket.Dispose(); }
        }) { IsBackground = true };
        var resize = new Thread(() => {
          try {
            active.Wait();
            int cols = 0, rows = 0;
            while (Volatile.Read(ref done) == 0) {
              int width = Console.WindowWidth, height = Console.WindowHeight;
              if ((width != cols || height != rows) && width > 0 && height > 0 && width <= 1000 && height <= 1000) {
                send(new { type = "resize", cols = width, rows = height }).GetAwaiter().GetResult();
                cols = width; rows = height;
              }
              Thread.Sleep(100);
            }
          } catch { socket.Dispose(); }
        }) { IsBackground = true };
        input.Start(); resize.Start();
        await send(new { type = "hello", role = "external", token, lease }).ConfigureAwait(false);
        bool welcomed = false;
        while (true) {
          string line = await reader.ReadLineAsync().ConfigureAwait(false);
          if (line == null) throw new IOException("Worker terminal connection closed");
          if (line.Length > 1024 * 1024) throw new IOException("Worker terminal frame is too large");
          var frame = receiveJson.DeserializeObject(line) as Dictionary<string, object>;
          if (frame == null || !frame.ContainsKey("type")) throw new IOException("Invalid worker frame");
          string type = frame["type"] as string;
          if (type == "welcome" && !welcomed && frame.ContainsKey("pid") && frame["pid"] is int) {
            welcomed = true; active.Set();
          } else if (type == "data" && welcomed && frame.ContainsKey("data") && frame["data"] is string) {
            byte[] data = utf8.GetBytes((string)frame["data"]);
            await output.WriteAsync(data, 0, data.Length).ConfigureAwait(false);
            await output.FlushAsync().ConfigureAwait(false);
          } else if (type == "exit" && welcomed && frame.ContainsKey("code") && frame["code"] is int) {
            return (int)frame["code"];
          } else throw new IOException("Invalid worker terminal response");
        }
      } finally {
        Interlocked.Exchange(ref done, 1);
        active.Set();
        SetConsoleMode(inputHandle, inputMode);
        SetConsoleMode(outputHandle, outputMode);
        Console.InputEncoding = inputEncoding;
        Console.OutputEncoding = outputEncoding;
      }
    }
  }
}
`;

const quotePS = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function workerTerminalConsoleCommand(configPath: string, lease: string): string {
  return `$ErrorActionPreference='Stop';
$config=Get-Content -LiteralPath ${quotePS(configPath)} -Raw | ConvertFrom-Json;
Add-Type -TypeDefinition @'
${consoleClient}
'@ -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll';
exit ([ZaicodeWorkerConsole]::Run($config.pipe,$config.token,${quotePS(lease)}).GetAwaiter().GetResult())`;
}
