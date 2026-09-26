// ZAICODE root launcher: double-click ZAICODE.exe in the workspace root.
// Starts the packaged app in ZAICODE mode (no console window), points it at
// the SAIPEN install, and restarts it after a crash unless disabled in
// %APPDATA%\ZAICODE\zaicode-launcher.json ({"autoRestartOnCrash": false}).
// Staged updates: `pnpm bundle:zaicode` builds into dist-next while the app
// runs; the launcher swaps dist-next into dist before starting the app.
// Start-up splash (SRC-048): the SAIPEN picture appears the moment ZAICODE.exe
// is double-clicked, before the build swap and the app start, and hands over
// to the app's own identical splash as soon as the app shows a window.
// Build: tools\launcher\build.cmd
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class ZaicodeLauncher
{
    private const string AppRelativePath = @"zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe";
    private const string LiveDir = @"zcode\packages\desktop\dist\win-unpacked";
    private const string StagedDir = @"zcode\packages\desktop\dist-next\win-unpacked";
    private const int RapidCrashSeconds = 30;
    private const int RapidCrashLimit = 5;

    private static string logPath;

    [STAThread]
    private static int Main(string[] args)
    {
        string workspace = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string settingsDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ZAICODE");
        Directory.CreateDirectory(settingsDirectory);
        logPath = Path.Combine(settingsDirectory, "launcher.log");
        string preferencesPath = Path.Combine(settingsDirectory, "zaicode-launcher.json");

        string executable = Path.Combine(workspace, AppRelativePath);
        string version = ReadVersion(workspace);
        if (!string.IsNullOrEmpty(version)) Environment.SetEnvironmentVariable("ZAICODE_VERSION", version);
        ZaicodeSplash.Show(workspace, version);
        ZaicodeSplash.SetStatus("Checking for a new build...");
        ApplyStagedBuild(workspace);
        if (!File.Exists(executable))
        {
            ZaicodeSplash.Close();
            Log("ZAICODE.exe missing: " + executable);
            MessageBox.Show(
                "ZAICODE app build is missing:\n" + executable +
                "\n\nBuild it from zcode\\ with: pnpm bundle:zaicode",
                "ZAICODE launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }

        EnsureCrispFonts(new[]
        {
            Path.Combine(Path.GetDirectoryName(executable), @"resources\zaicode-fonts"),
            Path.Combine(workspace, @"zcode\packages\desktop\build\zaicode-fonts"),
        });

        Environment.SetEnvironmentVariable("ZCODE_ZAICODE_MODE", "1");
        Environment.SetEnvironmentVariable("ZCODE_ZAICODE_IDENTITY", "1");
        // A TZ inherited from an agent shell (TZ=UTC) moves every ZAICODE clock by the zone
        // offset: Chromium fixes its zone at start, so the variable must never reach the app.
        Environment.SetEnvironmentVariable("TZ", null);
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SAIPEN_HOME")))
        {
            // The installer's own SAIPEN clone first (install\Install-ZAICODE.ps1), then the scheduled source.
            string[] saipenHomes =
            {
                Path.Combine(workspace, "saipen"),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    @"saipen\scheduled-source"),
            };
            foreach (string saipenHome in saipenHomes)
            {
                if (!File.Exists(Path.Combine(saipenHome, @"bin\saipen.cmd"))) continue;
                Environment.SetEnvironmentVariable("SAIPEN_HOME", saipenHome);
                break;
            }
        }
        PrependInstallTools(workspace);
        ZaicodeSplash.SetStatus("Starting ZAICODE...");

        int rapidCrashes = 0;
        while (true)
        {
            DateTime started = DateTime.Now;
            int exitCode;
            try
            {
                var info = new ProcessStartInfo(executable)
                {
                    WorkingDirectory = Path.GetDirectoryName(executable),
                    UseShellExecute = false,
                    Arguments = string.Join(" ", Array.ConvertAll(args, Quote)),
                };
                using (Process process = Process.Start(info))
                {
                    ZaicodeSplash.CloseWhenWindowShows(process.Id);
                    process.WaitForExit();
                    exitCode = process.ExitCode;
                }
                ZaicodeSplash.Close();
            }
            catch (Exception error)
            {
                ZaicodeSplash.Close();
                Log("Launch failed: " + error.Message);
                MessageBox.Show("ZAICODE failed to start:\n" + error.Message, "ZAICODE launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 3;
            }

            if (exitCode == 0)
            {
                Log("Normal exit");
                return 0;
            }
            Log("Process exited with code " + exitCode);
            if (!AutoRestartEnabled(preferencesPath)) return exitCode;

            rapidCrashes = (DateTime.Now - started).TotalSeconds < RapidCrashSeconds ? rapidCrashes + 1 : 0;
            if (rapidCrashes >= RapidCrashLimit)
            {
                Log("Stopped after five rapid crashes");
                return exitCode;
            }
            Thread.Sleep(2000);
            ApplyStagedBuild(workspace);
        }
    }

    private static string ReadVersion(string workspace)
    {
        try
        {
            string path = Path.Combine(workspace, "VERSION");
            return File.Exists(path) ? File.ReadAllText(path).Trim() : "";
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// An installed ZAICODE brings private copies of what the machine lacked
    /// (Git, Node.js, SAIMAIL's venv) under the workspace; the app, its agents
    /// and its workers find them first. A developer workspace has none of
    /// these folders, so nothing changes there.
    /// </summary>
    private static void PrependInstallTools(string workspace)
    {
        string[] dirs =
        {
            Path.Combine(workspace, @".venv\Scripts"),
            Path.Combine(workspace, @".tools\git\cmd"),
            Path.Combine(workspace, @".tools\node"),
        };
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        for (int index = dirs.Length - 1; index >= 0; index--)
        {
            if (Directory.Exists(dirs[index])) path = dirs[index] + ";" + path;
        }
        Environment.SetEnvironmentVariable("PATH", path);
    }

    /// <summary>
    /// Swaps a newer staged build (dist-next) into place. Runs only before the
    /// app starts, so no file is locked; the previous build is kept as
    /// win-unpacked.previous until the next swap for a manual rollback.
    /// </summary>
    private static void ApplyStagedBuild(string workspace)
    {
        string staged = Path.Combine(workspace, StagedDir);
        string live = Path.Combine(workspace, LiveDir);
        string stagedExe = Path.Combine(staged, "ZAICODE.exe");
        if (!File.Exists(stagedExe)) return;
        string liveExe = Path.Combine(live, "ZAICODE.exe");
        if (File.Exists(liveExe) && File.GetLastWriteTimeUtc(liveExe) >= File.GetLastWriteTimeUtc(stagedExe))
        {
            Log("Staged build is not newer than live build; leaving it in place");
            return;
        }
        string previous = live + ".previous";
        try
        {
            if (Directory.Exists(previous)) RemoveBuildDirectory(previous);
            if (Directory.Exists(live)) Directory.Move(live, previous);
            Directory.CreateDirectory(Path.GetDirectoryName(live));
            Directory.Move(staged, live);
            Log("Applied staged build from dist-next");
        }
        catch (Exception error)
        {
            Log("Staged build swap failed: " + error.Message);
            if (!Directory.Exists(live) && Directory.Exists(previous))
            {
                try { Directory.Move(previous, live); } catch { /* keep logging only */ }
            }
        }
    }

    /// <summary>
    /// Removes an old build. The bundled router ships a Next.js output whose
    /// deepest files pass MAX_PATH, which Directory.Delete (legacy .NET path
    /// handling) cannot reach: the swap failed and the old build kept running
    /// (T-58). Fallback: rd with the \\?\ prefix (long-path aware); last resort:
    /// move it aside under a unique name so the swap still happens.
    /// </summary>
    private static void RemoveBuildDirectory(string path)
    {
        try
        {
            Directory.Delete(path, true);
            return;
        }
        catch (Exception error)
        {
            Log("Delete " + Path.GetFileName(path) + " failed (" + error.Message + "); retrying long-path aware");
        }
        try
        {
            var info = new ProcessStartInfo(
                Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /c rd /s /q \"\\\\?\\" + path + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using (Process process = Process.Start(info))
            {
                process.WaitForExit(120000);
            }
        }
        catch (Exception error)
        {
            Log("rd failed: " + error.Message);
        }
        if (!Directory.Exists(path)) return;
        string aside = path + "-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        Directory.Move(path, aside);
        Log("Old build moved aside to " + Path.GetFileName(aside) + " (delete it by hand)");
    }

    [System.Runtime.InteropServices.DllImport("gdi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int AddFontResource(string fileName);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    private const string FontsKey = @"Software\Microsoft\Windows NT\CurrentVersion\Fonts";

    /// <summary>
    /// Installs the pixel-exact ZAICODE fonts (Verdana_m1, Terminus TTF) for
    /// the current user when they are missing, before the app starts, so a
    /// fresh machine renders crisp aliased text from the first launch. The
    /// fonts carry embedded bitmap strikes that DirectWrite draws without
    /// anti-aliasing; as web fonts those strikes would be stripped.
    /// Per-user install: no admin rights, %LOCALAPPDATA%\Microsoft\Windows\Fonts.
    /// </summary>
    private static void EnsureCrispFonts(string[] sourceDirs)
    {
        try
        {
            string sourceDir = Array.Find(sourceDirs, dir => File.Exists(Path.Combine(dir, "zaicode-fonts.json")));
            if (sourceDir == null)
            {
                Log("Crisp fonts: no zaicode-fonts.json next to the app; skipped");
                return;
            }
            string manifest = File.ReadAllText(Path.Combine(sourceDir, "zaicode-fonts.json"));
            var entries = System.Text.RegularExpressions.Regex.Matches(
                manifest, "\"file\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"registryName\"\\s*:\\s*\"([^\"]+)\"");
            string userFonts = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Microsoft\Windows\Fonts");
            int installed = 0;
            using (var userKey = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(FontsKey))
            using (var machineKey = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(FontsKey))
            {
                foreach (System.Text.RegularExpressions.Match entry in entries)
                {
                    string file = entry.Groups[1].Value;
                    string registryName = entry.Groups[2].Value;
                    if (userKey.GetValue(registryName) != null) continue;
                    if (machineKey != null && machineKey.GetValue(registryName) != null) continue;
                    string source = Path.Combine(sourceDir, file);
                    if (!File.Exists(source)) continue;
                    Directory.CreateDirectory(userFonts);
                    string target = Path.Combine(userFonts, file);
                    if (!File.Exists(target)) File.Copy(source, target);
                    userKey.SetValue(registryName, target);
                    AddFontResource(target);
                    installed++;
                    Log("Crisp fonts: installed " + registryName);
                }
            }
            if (installed > 0)
            {
                // WM_FONTCHANGE to every top-level window; PostMessage never blocks on a hung window.
                PostMessage(new IntPtr(0xffff), 0x001D, IntPtr.Zero, IntPtr.Zero);
            }
        }
        catch (Exception error)
        {
            Log("Crisp fonts: install failed: " + error.Message);
        }
    }

    private static bool AutoRestartEnabled(string preferencesPath)
    {
        try
        {
            string json = File.ReadAllText(preferencesPath);
            return !System.Text.RegularExpressions.Regex.IsMatch(
                json, "\"autoRestartOnCrash\"\\s*:\\s*false");
        }
        catch
        {
            return true;
        }
    }

    private static string Quote(string argument)
    {
        if (string.IsNullOrEmpty(argument))
            return "\"\"";

        if (argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '\"' }) < 0)
            return argument;

        var sb = new System.Text.StringBuilder();
        sb.Append('"');
        for (int i = 0; i < argument.Length; i++)
        {
            int backslashCount = 0;
            while (i < argument.Length && argument[i] == '\\')
            {
                backslashCount++;
                i++;
            }

            if (i == argument.Length)
            {
                sb.Append('\\', backslashCount * 2);
                break;
            }

            if (argument[i] == '"')
            {
                sb.Append('\\', backslashCount * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashCount);
                sb.Append(argument[i]);
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    internal static void Log(string message)
    {
        try
        {
            File.AppendAllText(logPath, DateTime.UtcNow.ToString("u") + " " + message + Environment.NewLine);
        }
        catch
        {
            // Logging is best effort.
        }
    }
}

/// <summary>
/// The launcher's start-up splash (SRC-048): a borderless 560x300 picture in the
/// centre of the primary work area -- the same size and place as the app's own
/// splash (packages/desktop/src/main/zaicodeSplash.ts), so the hand-over is
/// invisible. It runs on its own UI thread, never locks the picture file (the
/// build swap moves that folder), and closes when the app shows any window, when
/// the app exits, or after two minutes.
/// </summary>
internal static class ZaicodeSplash
{
    private const int Width = 560;
    private const int Height = 300;
    private const int MaxMilliseconds = 120000;
    private static volatile SplashForm form;

    private static readonly string[] ImageCandidates =
    {
        @"zcode\packages\desktop\dist\win-unpacked\resources\zaicode-splash\splash.png",
        @"zcode\packages\desktop\dist-next\win-unpacked\resources\zaicode-splash\splash.png",
        @"zcode\packages\desktop\build\zaicode-splash\splash.png",
    };

    public static void Show(string workspace, string version)
    {
        if (Environment.GetEnvironmentVariable("ZAICODE_NO_SPLASH") == "1") return;
        byte[] bytes = null;
        foreach (string candidate in ImageCandidates)
        {
            string path = Path.Combine(workspace, candidate);
            try
            {
                if (File.Exists(path))
                {
                    bytes = File.ReadAllBytes(path);
                    break;
                }
            }
            catch
            {
                // try the next one
            }
        }
        if (bytes == null) return;
        var shown = new ManualResetEvent(false);
        var thread = new Thread(() =>
        {
            try
            {
                var splash = new SplashForm(bytes, version);
                splash.Shown += (sender, args) => shown.Set();
                form = splash;
                Application.Run(splash);
            }
            catch (Exception error)
            {
                ZaicodeLauncher.Log("Splash failed: " + error.Message);
                shown.Set();
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        shown.WaitOne(3000);
    }

    public static void SetStatus(string text)
    {
        SplashForm splash = form;
        if (splash == null || !splash.IsHandleCreated) return;
        try { splash.BeginInvoke((Action)(() => splash.SetStatus(text))); } catch { /* closing */ }
    }

    public static void Close()
    {
        SplashForm splash = form;
        form = null;
        if (splash == null || !splash.IsHandleCreated) return;
        try { splash.BeginInvoke((Action)(() => splash.Close())); } catch { /* already closed */ }
    }

    /// <summary>Closes the splash once the app process shows a top-level window (its own splash or the main window).</summary>
    public static void CloseWhenWindowShows(int processId)
    {
        if (form == null) return;
        var thread = new Thread(() =>
        {
            var watch = Stopwatch.StartNew();
            while (form != null && watch.ElapsedMilliseconds < MaxMilliseconds)
            {
                if (HasVisibleWindow(processId))
                {
                    // One frame for the app's window to paint before this one goes.
                    Thread.Sleep(120);
                    break;
                }
                try
                {
                    if (Process.GetProcessById(processId).HasExited) break;
                }
                catch
                {
                    break;
                }
                Thread.Sleep(100);
            }
            Close();
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    private static bool HasVisibleWindow(int processId)
    {
        bool found = false;
        EnumWindows((hWnd, lParam) =>
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner != (uint)processId || !IsWindowVisible(hWnd)) return true;
            Rect rect;
            // Tiny helper windows (tray, message sinks) do not count.
            if (GetWindowRect(hWnd, out rect) && rect.Right - rect.Left >= 200 && rect.Bottom - rect.Top >= 100)
            {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private sealed class SplashForm : Form
    {
        private readonly Image picture;
        private readonly string version;
        private readonly Font font = new Font("Verdana", 11f, FontStyle.Regular, GraphicsUnit.Pixel);
        private string status = "Starting ZAICODE...";

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        public SplashForm(byte[] png, string version)
        {
            this.version = string.IsNullOrEmpty(version) ? "ZAICODE" : "ZAICODE " + version;
            // A copy in memory: the stream stays with the image, the file on disk stays free.
            picture = Image.FromStream(new MemoryStream(png));
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
            Text = "ZAICODE";
            BackColor = Color.FromArgb(0x1A, 0x18, 0x10);
            DoubleBuffered = true;
            ClientSize = new Size(Width, Height);
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(area.X + (area.Width - Width) / 2, area.Y + (area.Height - Height) / 2);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* default icon */ }
            MouseDown += (sender, args) =>
            {
                if (args.Button != MouseButtons.Left) return;
                ReleaseCapture();
                SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); // drag by the picture
            };
        }

        public void SetStatus(string text)
        {
            status = text;
            Invalidate(new Rectangle(8, Height - 30, Width - 16, 22));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.DrawImageUnscaled(picture, 0, 0);
            // Pixel text, no smoothing (saipen UI iron law 1).
            e.Graphics.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
            using (var text = new SolidBrush(Color.FromArgb(0xD4, 0xC8, 0x9A)))
            using (var dim = new SolidBrush(Color.FromArgb(0x9C, 0x93, 0x71)))
            {
                e.Graphics.DrawString(status, font, text, 14, Height - 27);
                SizeF size = e.Graphics.MeasureString(version, font);
                e.Graphics.DrawString(version, font, dim, Width - 14 - size.Width, Height - 27);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                picture.Dispose();
                font.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
