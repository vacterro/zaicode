using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// ZAICODE ProTrail input (SRC-062): ProTrail's own mouse source. A Raw Input
// sink (RIDEV_INPUTSINK) on a message-only window sees every mouse packet on
// the desktop without hooking or delaying input; each packet's position is
// GetCursorPos in physical pixels. One line per event on stdout:
//   m X Y T | d B X Y T | u B X Y T   (B: 0 left, 1 middle, 2 right; T: ms)
// The process ends when its stdin closes (ZAICODE exited or stopped it).
static class ZaicodeProtrailInput
{
    const int WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const int PENDING_LIMIT = 262144;

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll")]
    static extern uint GetRawInputData(IntPtr rawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    static readonly object Gate = new object();
    static readonly StringBuilder Pending = new StringBuilder();
    static readonly AutoResetEvent Signal = new AutoResetEvent(false);
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly int HeaderSize = IntPtr.Size == 8 ? 24 : 16;
    static readonly IntPtr Buffer = Marshal.AllocHGlobal(512);
    static int lastX = int.MinValue;
    static int lastY = int.MinValue;

    sealed class Sink : NativeWindow
    {
        public Sink()
        {
            CreateParams cp = new CreateParams();
            cp.Parent = new IntPtr(-3); // HWND_MESSAGE: never shown, never hit-tested
            CreateHandle(cp);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_INPUT) Packet(m.LParam);
            base.WndProc(ref m);
        }
    }

    [STAThread]
    static int Main()
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        Thread writer = new Thread(Write);
        writer.IsBackground = true;
        writer.Start();
        Thread parent = new Thread(WatchParent);
        parent.IsBackground = true;
        parent.Start();
        Sink sink = new Sink();
        RAWINPUTDEVICE[] devices = new RAWINPUTDEVICE[1];
        devices[0].UsagePage = 0x01; // generic desktop
        devices[0].Usage = 0x02;     // mouse
        devices[0].Flags = RIDEV_INPUTSINK;
        devices[0].Target = sink.Handle;
        if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        {
            Emit("error register " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
            Thread.Sleep(200);
            return 2;
        }
        Emit("ready");
        Application.Run();
        return 0;
    }

    static void WatchParent()
    {
        try
        {
            Stream input = Console.OpenStandardInput();
            byte[] chunk = new byte[64];
            while (input.Read(chunk, 0, chunk.Length) > 0) { }
        }
        catch (IOException) { }
        Environment.Exit(0);
    }

    static void Write()
    {
        StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        while (true)
        {
            Signal.WaitOne();
            string text;
            lock (Gate)
            {
                text = Pending.ToString();
                Pending.Length = 0;
            }
            if (text.Length == 0) continue;
            try
            {
                output.Write(text);
                output.Flush();
            }
            catch (IOException)
            {
                Environment.Exit(0);
            }
        }
    }

    static void Emit(string line)
    {
        lock (Gate)
        {
            // A stalled reader must never slow the mouse: drop instead of blocking.
            if (Pending.Length > PENDING_LIMIT) return;
            Pending.Append(line).Append('\n');
        }
        Signal.Set();
    }

    static string Stamp()
    {
        return Clock.Elapsed.TotalMilliseconds.ToString("F3", CultureInfo.InvariantCulture);
    }

    static void Button(int flags, int down, int up, int button, POINT p, string t)
    {
        string b = button.ToString(CultureInfo.InvariantCulture);
        string xy = p.X.ToString(CultureInfo.InvariantCulture) + " " + p.Y.ToString(CultureInfo.InvariantCulture);
        if ((flags & down) != 0) Emit("d " + b + " " + xy + " " + t);
        if ((flags & up) != 0) Emit("u " + b + " " + xy + " " + t);
    }

    static void Packet(IntPtr handle)
    {
        uint size = 512;
        uint got = GetRawInputData(handle, RID_INPUT, Buffer, ref size, (uint)HeaderSize);
        if (got == uint.MaxValue || got < (uint)(HeaderSize + 24)) return;
        if (Marshal.ReadInt32(Buffer, 0) != 0) return; // RIM_TYPEMOUSE
        int flags = (ushort)Marshal.ReadInt16(Buffer, HeaderSize + 4);
        int dx = Marshal.ReadInt32(Buffer, HeaderSize + 12);
        int dy = Marshal.ReadInt32(Buffer, HeaderSize + 16);
        string t = Stamp();
        POINT p;
        // Every left/right/middle transition in the packet, in ProTrail's order
        // (one packet may carry several, e.g. left-down with right-up).
        if ((flags & 0x3F) != 0)
        {
            if (!GetCursorPos(out p)) return;
            Button(flags, 0x01, 0x02, 0, p, t);
            Button(flags, 0x04, 0x08, 2, p, t);
            Button(flags, 0x10, 0x20, 1, p, t);
            lastX = p.X;
            lastY = p.Y;
            return;
        }
        if (dx == 0 && dy == 0) return; // wheel-only packets
        if (!GetCursorPos(out p) || (p.X == lastX && p.Y == lastY)) return;
        lastX = p.X;
        lastY = p.Y;
        Emit("m " + p.X.ToString(CultureInfo.InvariantCulture) + " " + p.Y.ToString(CultureInfo.InvariantCulture) + " " + t);
    }
}
