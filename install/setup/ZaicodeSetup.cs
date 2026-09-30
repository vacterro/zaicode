// ZAICODE-Setup.exe: the one-click installer window. It carries install\*.ps1 and the
// SAIPEN banner as resources, unpacks the scripts into a temporary folder and runs
// Install-ZAICODE.ps1 with Windows PowerShell in the background, reading its
// "##ZAICODE {json}" progress lines (ZAICODE_SETUP_PROGRESS=1) to draw every step.
//
//   ZAICODE-Setup.exe                     window: pick a folder, press INSTALL
//   ZAICODE-Setup.exe /auto               window that starts installing at once
//   ZAICODE-Setup.exe /quiet [args]       no window: the console installer, exit code = result
//   any other argument goes to Install-ZAICODE.ps1 (for example -InstallDir D:\ZAICODE)
//
// Build: install\setup\build.cmd
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ZaicodeSetup
{
    internal static readonly string[] Scripts =
    {
        "Install-ZAICODE.ps1", "ZaicodeInstallLib.ps1", "ZaicodeChecks.ps1", "ZAICODE-Doctor.ps1", "Update-ZAICODE.ps1",
    };

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [STAThread]
    private static int Main(string[] args)
    {
        var passThrough = new List<string>();
        bool quiet = false, auto = false;
        foreach (string arg in args)
        {
            string lower = arg.ToLowerInvariant();
            if (lower == "/quiet" || lower == "--quiet") quiet = true;
            else if (lower == "/auto" || lower == "--auto") auto = true;
            else passThrough.Add(arg);
        }
        string scripts = UnpackScripts();
        try
        {
            if (quiet) return RunConsole(scripts, passThrough);
            try { SetProcessDPIAware(); } catch { /* older Windows: scaled by the system */ }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var window = new SetupForm(scripts, passThrough, auto);
            Application.Run(window);
            return window.ExitCode;
        }
        finally
        {
            try { Directory.Delete(scripts, true); } catch { /* temp folder only */ }
        }
    }

    private static string UnpackScripts()
    {
        string folder = Path.Combine(Path.GetTempPath(), "zaicode-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(folder);
        Assembly assembly = Assembly.GetExecutingAssembly();
        foreach (string name in Scripts)
        {
            using (Stream source = assembly.GetManifestResourceStream(name))
            {
                if (source == null) throw new InvalidOperationException("missing resource " + name);
                using (FileStream target = File.Create(Path.Combine(folder, name))) source.CopyTo(target);
            }
        }
        return folder;
    }

    internal static Image LoadBanner()
    {
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("banner.png"))
        {
            if (source == null) return null;
            var copy = new MemoryStream();
            source.CopyTo(copy);
            copy.Position = 0;
            return Image.FromStream(copy);
        }
    }

    internal static string PowerShellArguments(string scripts, IEnumerable<string> passThrough)
    {
        var builder = new StringBuilder("-NoProfile -ExecutionPolicy Bypass -File ");
        builder.Append(Quote(Path.Combine(scripts, "Install-ZAICODE.ps1")));
        foreach (string arg in passThrough) builder.Append(' ').Append(Quote(arg));
        return builder.ToString();
    }

    private static int RunConsole(string scripts, List<string> passThrough)
    {
        var info = new ProcessStartInfo("powershell.exe", PowerShellArguments(scripts, passThrough)) { UseShellExecute = false };
        using (Process process = Process.Start(info))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    internal static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}

/// <summary>One installer step as the window draws it.</summary>
internal sealed class SetupStep
{
    public string Id;
    public string Title;
    public string Status = "PENDING";
    public string Detail = "";
}

internal sealed class SetupForm : Form
{
    // The ZAICODE palette: the launcher splash's colours (tools\launcher\ZaicodeLauncher.cs).
    private static readonly Color Background = Color.FromArgb(0x1A, 0x18, 0x10);
    private static readonly Color Surface = Color.FromArgb(0x24, 0x21, 0x16);
    private static readonly Color Line = Color.FromArgb(0x4A, 0x43, 0x2A);
    private static readonly Color Gold = Color.FromArgb(0xE8, 0xC0, 0x4A);
    private static readonly Color GoldDark = Color.FromArgb(0x8A, 0x6A, 0x10);
    private static readonly Color Ink = Color.FromArgb(0xD4, 0xC8, 0x9A);
    private static readonly Color Dim = Color.FromArgb(0x9C, 0x93, 0x71);
    private static readonly Color Good = Color.FromArgb(0x9C, 0xC8, 0x5A);
    private static readonly Color Warn = Color.FromArgb(0xE8, 0x9A, 0x3A);
    private static readonly Color Bad = Color.FromArgb(0xE0, 0x5A, 0x4A);

    private enum Page { Welcome, Running, Finished }

    private readonly string scripts;
    private readonly List<string> passThrough;
    private readonly bool autoStart;
    private readonly float scale;
    private readonly Image banner;
    private readonly Font font;
    private readonly Font bold;
    private readonly Font big;
    private readonly Font title;
    // Verdana has no check marks or spinner quarters: the symbols come from Segoe UI Symbol.
    private readonly Font symbols;
    private readonly List<SetupStep> steps = new List<SetupStep>();
    private readonly StringBuilder log = new StringBuilder();
    private readonly Timer tick = new Timer();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly Stopwatch clock = new Stopwatch();

    private Page page = Page.Welcome;
    private string installDir;
    private bool desktopShortcut = true, startMenu = true, launchWhenDone = true, showLog;
    private Process process;
    private string phase = "";
    private string logFile = "";
    private string launcher = "";
    private bool succeeded;
    private int spinner;
    private readonly List<HotSpot> spots = new List<HotSpot>();
    private HotSpot hover;

    public int ExitCode { get; private set; }

    private sealed class HotSpot
    {
        public Rectangle Bounds;
        public string Id;
        public Action Click;
        public bool Primary;
        public string Label;
    }

    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public SetupForm(string scripts, List<string> passThrough, bool autoStart)
    {
        this.scripts = scripts;
        this.passThrough = new List<string>(passThrough);
        this.autoStart = autoStart;
        using (Graphics g = CreateGraphics()) scale = Math.Max(1f, (float)Math.Round(g.DpiX / 96f * 2) / 2);
        installDir = TakeOption("-InstallDir") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "ZAICODE");
        if (TakeSwitch("-NoShortcut")) desktopShortcut = false;
        if (TakeSwitch("-NoStartMenu")) startMenu = false;
        banner = ZaicodeSetup.LoadBanner();
        font = new Font("Verdana", S(11), FontStyle.Regular, GraphicsUnit.Pixel);
        bold = new Font("Verdana", S(11), FontStyle.Bold, GraphicsUnit.Pixel);
        big = new Font("Verdana", S(16), FontStyle.Bold, GraphicsUnit.Pixel);
        title = new Font("Verdana", S(13), FontStyle.Bold, GraphicsUnit.Pixel);
        symbols = new Font("Segoe UI Symbol", S(12), FontStyle.Bold, GraphicsUnit.Pixel);

        Text = "ZAICODE Setup";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Background;
        DoubleBuffered = true;
        ClientSize = new Size(S(600), S(600));
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* default icon */ }
        tick.Interval = 120;
        tick.Tick += (sender, args) => { spinner++; Invalidate(); };
        MouseDown += OnMouseDownDrag;
        MouseMove += (sender, args) => { HotSpot at = SpotAt(args.Location); if (at != hover) { hover = at; Cursor = at != null ? Cursors.Hand : Cursors.Default; Invalidate(); } };
        MouseClick += (sender, args) => { HotSpot at = SpotAt(args.Location); if (at != null && args.Button == MouseButtons.Left) at.Click(); };
        KeyPreview = true;
        KeyDown += (sender, args) =>
        {
            if (args.KeyCode == Keys.Escape) CloseOrCancel();
            if (args.KeyCode == Keys.Enter && page == Page.Welcome) StartInstall();
        };
        Shown += (sender, args) => { if (this.autoStart) StartInstall(); };
    }

    private int S(int value) { return (int)Math.Round(value * scale); }

    private string TakeOption(string name)
    {
        int at = passThrough.FindIndex(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));
        if (at < 0 || at + 1 >= passThrough.Count) return null;
        string value = passThrough[at + 1];
        passThrough.RemoveRange(at, 2);
        return value;
    }

    private bool TakeSwitch(string name)
    {
        int at = passThrough.FindIndex(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));
        if (at < 0) return false;
        passThrough.RemoveAt(at);
        return true;
    }

    private bool ExistingInstall()
    {
        return File.Exists(Path.Combine(installDir, @"install\install-state.json")) || Directory.Exists(Path.Combine(installDir, @"zcode\.git"));
    }

    private void OnMouseDownDrag(object sender, MouseEventArgs args)
    {
        if (args.Button != MouseButtons.Left || SpotAt(args.Location) != null) return;
        ReleaseCapture();
        SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero);
    }

    private HotSpot SpotAt(Point point)
    {
        for (int i = spots.Count - 1; i >= 0; i--) if (spots[i].Bounds.Contains(point)) return spots[i];
        return null;
    }

    private void CloseOrCancel()
    {
        if (page != Page.Running) { Close(); return; }
        if (MessageBox.Show(this, "Stop the installation? What is already installed stays; running Setup again continues from there.", "ZAICODE Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        KillProcessTree();
        Finish(false, "Stopped. Run Setup again to continue.");
    }

    // ------------------------------------------------------------------
    // The installer process
    // ------------------------------------------------------------------

    private void StartInstall()
    {
        if (page == Page.Running) return;
        steps.Clear();
        log.Clear();
        phase = ExistingInstall() ? "Updating and repairing ZAICODE" : "Installing ZAICODE";
        succeeded = false;
        page = Page.Running;
        showLog = false;
        var args = new List<string>(passThrough) { "-InstallDir", installDir };
        if (!desktopShortcut) args.Add("-NoShortcut");
        if (!startMenu) args.Add("-NoStartMenu");
        var info = new ProcessStartInfo("powershell.exe", ZaicodeSetup.PowerShellArguments(scripts, args))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        info.EnvironmentVariables["ZAICODE_SETUP_PROGRESS"] = "1";
        process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (sender, e) => { if (e.Data != null) BeginInvoke((Action)(() => OnLine(e.Data))); };
        process.ErrorDataReceived += (sender, e) => { if (e.Data != null) BeginInvoke((Action)(() => AppendLog(e.Data))); };
        process.Exited += (sender, e) => BeginInvoke((Action)OnExited);
        clock.Restart();
        tick.Start();
        try
        {
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch (Exception error)
        {
            Finish(false, "Windows PowerShell did not start: " + error.Message);
        }
        Invalidate();
    }

    private void OnLine(string line)
    {
        if (!line.StartsWith("##ZAICODE ", StringComparison.Ordinal)) { AppendLog(line); return; }
        Dictionary<string, object> message;
        try { message = json.Deserialize<Dictionary<string, object>>(line.Substring(10)); }
        catch { AppendLog(line); return; }
        string type = Get(message, "type");
        if (type == "plan")
        {
            var list = message.ContainsKey("checks") ? message["checks"] as System.Collections.ArrayList : null;
            if (list == null) return;
            var known = new Dictionary<string, SetupStep>();
            foreach (SetupStep step in steps) known[step.Id] = step;
            steps.Clear();
            foreach (object entry in list)
            {
                var check = entry as Dictionary<string, object>;
                if (check == null) continue;
                string id = Get(check, "id");
                SetupStep step;
                if (!known.TryGetValue(id, out step)) step = new SetupStep { Id = id, Title = Get(check, "title") };
                steps.Add(step);
            }
        }
        else if (type == "check")
        {
            SetupStep step = steps.Find(s => s.Id == Get(message, "id"));
            if (step == null) return;
            step.Status = Get(message, "status").ToUpperInvariant();
            step.Detail = Get(message, "detail");
        }
        else if (type == "phase")
        {
            phase = Get(message, "title");
        }
        else if (type == "done")
        {
            logFile = Get(message, "log");
            launcher = Get(message, "launcher");
        }
        Invalidate();
    }

    private static string Get(Dictionary<string, object> map, string key)
    {
        object value;
        return map.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    private void AppendLog(string line)
    {
        log.AppendLine(line);
        if (log.Length > 200000) log.Remove(0, log.Length - 150000);
        if (showLog) Invalidate();
    }

    private void OnExited()
    {
        if (page != Page.Running) return;
        int code = process.ExitCode;
        bool ok = code == 0 && !steps.Exists(s => s.Status == "FAIL");
        Finish(ok, ok ? "Done" : "Not finished");
    }

    private void Finish(bool ok, string text)
    {
        tick.Stop();
        clock.Stop();
        succeeded = ok;
        phase = text;
        page = Page.Finished;
        ExitCode = ok ? 0 : 1;
        if (string.IsNullOrEmpty(launcher)) launcher = Path.Combine(installDir, "ZAICODE.exe");
        Invalidate();
        if (ok && launchWhenDone && autoStart == false) StartZaicode();
    }

    private void StartZaicode()
    {
        try
        {
            if (File.Exists(launcher)) Process.Start(new ProcessStartInfo(launcher) { WorkingDirectory = Path.GetDirectoryName(launcher), UseShellExecute = true });
            Close();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, "ZAICODE did not start: " + error.Message, "ZAICODE Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void KillProcessTree()
    {
        if (process == null) return;
        try
        {
            if (process.HasExited) return;
            string taskkill = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
            Process.Start(new ProcessStartInfo(taskkill, "/PID " + process.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false }).WaitForExit(10000);
        }
        catch { /* already gone */ }
    }

    private void OpenPath(string path)
    {
        try { if (!string.IsNullOrEmpty(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); } catch { /* nothing to open */ }
    }

    private void RunDoctor()
    {
        string doctor = Path.Combine(installDir, @"install\Doctor.cmd");
        if (!File.Exists(doctor)) { StartInstall(); return; }
        OpenPath(doctor);
    }

    private void ChooseFolder()
    {
        using (var dialog = new FolderBrowserDialog { Description = "Where ZAICODE goes (a new or an existing ZAICODE folder)", SelectedPath = Directory.Exists(installDir) ? installDir : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) })
        {
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            string chosen = dialog.SelectedPath;
            bool empty = !Directory.Exists(chosen) || Directory.GetFileSystemEntries(chosen).Length == 0;
            bool zaicode = File.Exists(Path.Combine(chosen, @"install\install-state.json")) || Directory.Exists(Path.Combine(chosen, @"zcode\.git"));
            installDir = empty || zaicode ? chosen : Path.Combine(chosen, "ZAICODE");
            Invalidate();
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (page == Page.Running)
        {
            if (MessageBox.Show(this, "Stop the installation and close?", "ZAICODE Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) { e.Cancel = true; return; }
            KillProcessTree();
            ExitCode = 1;
        }
        base.OnFormClosing(e);
    }

    // ------------------------------------------------------------------
    // Drawing: one custom-painted surface, pixel text (no smoothing), gold on dark.
    // ------------------------------------------------------------------

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
        spots.Clear();
        Size box = ClientSize;
        using (var border = new Pen(Line)) g.DrawRectangle(border, 0, 0, box.Width - 1, box.Height - 1);
        DrawChrome(g, box);
        if (page == Page.Welcome) DrawWelcome(g, box);
        else DrawProgress(g, box);
    }

    private void DrawChrome(Graphics g, Size box)
    {
        var close = new Rectangle(box.Width - S(34), S(6), S(26), S(22));
        var minimize = new Rectangle(box.Width - S(62), S(6), S(26), S(22));
        AddSpot(close, "close", CloseOrCancel, false, "x");
        AddSpot(minimize, "min", () => WindowState = FormWindowState.Minimized, false, "_");
        foreach (HotSpot spot in new[] { spots[spots.Count - 2], spots[spots.Count - 1] })
        {
            if (spot == hover) using (var fill = new SolidBrush(spot.Id == "close" ? Color.FromArgb(0x6A, 0x24, 0x1C) : Surface)) g.FillRectangle(fill, spot.Bounds);
            DrawCentered(g, spot.Label == "x" ? "\u2715" : "\u2013", symbols, Ink, spot.Bounds);
        }
    }

    private void DrawWelcome(Graphics g, Size box)
    {
        int y = S(34);
        if (banner != null)
        {
            var target = new Rectangle((box.Width - S(banner.Width)) / 2, y, S(banner.Width), S(banner.Height));
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(banner, target);
            y = target.Bottom + S(18);
        }
        bool existing = ExistingInstall();
        DrawCentered(g, existing ? "ZAICODE is already here: update and repair it" : "ZAICODE  +  SAIPEN  +  SAIMAIL", title, Gold, new Rectangle(0, y, box.Width, S(20)));
        y += S(24);
        DrawCentered(g, existing ? "Every part is brought up to date; what broke is repaired." : "One install. Free models work at once, no keys, no sign-up.", font, Dim, new Rectangle(0, y, box.Width, S(16)));
        y += S(30);

        int left = S(28), right = box.Width - S(28);
        DrawAt(g, "Install to", font, Dim, left, y + S(5));
        var field = new Rectangle(left + S(84), y, right - left - S(84) - S(96), S(26));
        using (var fill = new SolidBrush(Surface)) g.FillRectangle(fill, field);
        using (var pen = new Pen(Line)) g.DrawRectangle(pen, field);
        DrawClipped(g, installDir, font, Ink, Rectangle.Inflate(field, -S(6), 0));
        DrawButton(g, new Rectangle(right - S(88), y, S(88), S(26)), "Change...", ChooseFolder, false);
        y += S(40);

        int x = left;
        x = DrawCheck(g, x, y, "Desktop shortcut", desktopShortcut, () => desktopShortcut = !desktopShortcut);
        x = DrawCheck(g, x + S(18), y, "Start menu", startMenu, () => startMenu = !startMenu);
        DrawCheck(g, x + S(18), y, "Start ZAICODE when done", launchWhenDone, () => launchWhenDone = !launchWhenDone);
        y += S(40);

        var install = new Rectangle((box.Width - S(260)) / 2, y, S(260), S(46));
        DrawButton(g, install, existing ? "UPDATE" : "INSTALL", StartInstall, true, big);
        y = install.Bottom + S(14);
        DrawCentered(g, "No administrator rights needed. The first run builds the app here (about 15-30 min).", font, Dim, new Rectangle(0, y, box.Width, S(16)));
    }

    private void DrawProgress(Graphics g, Size box)
    {
        int left = S(24), right = box.Width - S(24);
        int y = S(34);
        if (banner != null)
        {
            int w = S(banner.Width) / 2, h = S(banner.Height) / 2;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(banner, new Rectangle(left, y, w, h));
            int tx = left + w + S(18);
            Color headColor = page == Page.Finished ? (succeeded ? Good : Bad) : Gold;
            DrawAt(g, page == Page.Finished ? (succeeded ? "ZAICODE is ready" : "Not finished yet") : phase, title, headColor, tx, y + S(8));
            DrawAt(g, Elapsed(), font, Dim, tx, y + S(32));
            int done = steps.FindAll(s => s.Status != "PENDING" && s.Status != "CHECKING" && s.Status != "REPAIRING").Count;
            SetupStep current = steps.Find(s => s.Status == "CHECKING" || s.Status == "REPAIRING");
            string now = page == Page.Finished
                ? (succeeded ? "Everything is installed." : "Some steps need another try.")
                : current != null ? (current.Status == "REPAIRING" ? "Setting up: " : "Checking: ") + current.Title : "Preparing...";
            DrawClipped(g, now, font, Ink, new Rectangle(tx, y + S(52), right - tx, S(16)));
            var bar = new Rectangle(tx, y + S(78), right - tx, S(14));
            using (var fill = new SolidBrush(Surface)) g.FillRectangle(fill, bar);
            float ratio = steps.Count == 0 ? 0 : (float)done / steps.Count;
            if (page == Page.Finished && succeeded) ratio = 1;
            if (ratio > 0)
            {
                var filled = new Rectangle(bar.X, bar.Y, Math.Max(1, (int)(bar.Width * ratio)), bar.Height);
                using (var fill = new LinearGradientBrush(bar, Gold, GoldDark, LinearGradientMode.Vertical)) g.FillRectangle(fill, filled);
            }
            using (var pen = new Pen(Line)) g.DrawRectangle(pen, bar);
            DrawAt(g, string.Format("{0} / {1}", done, Math.Max(steps.Count, done)), font, Dim, tx, bar.Bottom + S(6));
            y += h + S(14);
        }

        var listArea = new Rectangle(left, y, right - left, box.Height - y - S(70));
        using (var fill = new SolidBrush(Surface)) g.FillRectangle(fill, listArea);
        using (var pen = new Pen(Line)) g.DrawRectangle(pen, listArea);
        if (showLog) DrawLog(g, Rectangle.Inflate(listArea, -S(8), -S(6)));
        else DrawSteps(g, Rectangle.Inflate(listArea, -S(8), -S(6)));

        int by = box.Height - S(56);
        DrawButton(g, new Rectangle(left, by, S(110), S(34)), showLog ? "Steps" : "Details", () => { showLog = !showLog; Invalidate(); }, false);
        if (page == Page.Running)
        {
            DrawButton(g, new Rectangle(right - S(110), by, S(110), S(34)), "Stop", CloseOrCancel, false);
        }
        else if (succeeded)
        {
            DrawButton(g, new Rectangle(right - S(200), by, S(200), S(34)), "START ZAICODE", StartZaicode, true, bold);
            DrawButton(g, new Rectangle(right - S(310), by, S(100), S(34)), "Close", Close, false);
        }
        else
        {
            DrawButton(g, new Rectangle(right - S(130), by, S(130), S(34)), "TRY AGAIN", StartInstall, true, bold);
            DrawButton(g, new Rectangle(right - S(280), by, S(140), S(34)), "Autotroubleshoot", RunDoctor, false);
            DrawButton(g, new Rectangle(left + S(120), by, S(100), S(34)), "Open log", () => OpenPath(logFile), false);
        }
    }

    private void DrawSteps(Graphics g, Rectangle area)
    {
        if (steps.Count == 0)
        {
            DrawCentered(g, "Getting the installer ready" + new string('.', 1 + spinner / 4 % 3), font, Dim, area);
            return;
        }
        int row = Math.Max(S(16), Math.Min(S(22), area.Height / steps.Count));
        int y = area.Y;
        foreach (SetupStep step in steps)
        {
            Color color;
            string glyph = Glyph(step.Status, out color);
            DrawAt(g, glyph, symbols, color, area.X, y + (row - S(16)) / 2);
            int titleWidth = S(250);
            DrawClipped(g, step.Title, font, step.Status == "PENDING" ? Dim : Ink, new Rectangle(area.X + S(22), y + (row - S(14)) / 2, titleWidth, S(16)));
            string detail = step.Status == "OK" ? "" : step.Detail;
            if (step.Status == "FIXED" && string.IsNullOrEmpty(detail)) detail = "set up";
            if (step.Status == "FIXED") detail = "set up";
            DrawClipped(g, detail, font, step.Status == "FAIL" ? Bad : Dim, new Rectangle(area.X + S(22) + titleWidth + S(8), y + (row - S(14)) / 2, area.Right - area.X - S(22) - titleWidth - S(8), S(16)));
            y += row;
            if (y + row > area.Bottom + 2) break;
        }
    }

    private string Glyph(string status, out Color color)
    {
        switch (status)
        {
            case "OK": color = Good; return "\u2713";
            case "FIXED": color = Gold; return "\u2713";
            case "WARN": color = Warn; return "!";
            case "INFO": color = Dim; return "i";
            case "FAIL": color = Bad; return "\u2717";
            case "CHECKING":
            case "REPAIRING":
                color = Gold;
                return new[] { "\u25D0", "\u25D3", "\u25D1", "\u25D2" }[spinner % 4];
            default: color = Line; return "\u00B7";
        }
    }

    private void DrawLog(Graphics g, Rectangle area)
    {
        string[] lines = log.ToString().Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
        int row = S(14);
        int count = Math.Max(1, area.Height / row);
        int start = Math.Max(0, lines.Length - count - 1);
        int y = area.Y;
        for (int i = start; i < lines.Length; i++)
        {
            DrawClipped(g, lines[i], font, Dim, new Rectangle(area.X, y, area.Width, row));
            y += row;
            if (y > area.Bottom - row) break;
        }
    }

    private string Elapsed()
    {
        TimeSpan span = clock.Elapsed;
        return string.Format("{0}:{1:00} elapsed{2}", (int)span.TotalMinutes, span.Seconds, page == Page.Running ? "  -  you can keep working, this window does it all" : "");
    }

    private int DrawCheck(Graphics g, int x, int y, string label, bool value, Action toggle)
    {
        var mark = new Rectangle(x, y + S(3), S(14), S(14));
        using (var fill = new SolidBrush(Surface)) g.FillRectangle(fill, mark);
        using (var pen = new Pen(value ? Gold : Line)) g.DrawRectangle(pen, mark);
        if (value) using (var fill = new SolidBrush(Gold)) g.FillRectangle(fill, Rectangle.Inflate(mark, -S(3), -S(3)));
        SizeF size = g.MeasureString(label, font);
        DrawAt(g, label, font, Ink, mark.Right + S(6), y + S(3));
        var bounds = new Rectangle(x, y, (int)(mark.Width + S(6) + size.Width), S(20));
        AddSpot(bounds, label, () => { toggle(); Invalidate(); }, false, label);
        return bounds.Right;
    }

    private void DrawButton(Graphics g, Rectangle bounds, string label, Action click, bool primary, Font face = null)
    {
        HotSpot spot = AddSpot(bounds, label, click, primary, label);
        bool over = spot == hover || (hover != null && hover.Id == spot.Id && hover.Bounds == spot.Bounds);
        if (primary)
        {
            using (var fill = new LinearGradientBrush(bounds, over ? Color.FromArgb(0xF6, 0xD2, 0x5C) : Gold, GoldDark, LinearGradientMode.Vertical)) g.FillRectangle(fill, bounds);
            using (var pen = new Pen(Color.FromArgb(0x5A, 0x44, 0x08))) g.DrawRectangle(pen, bounds.X, bounds.Y, bounds.Width - 1, bounds.Height - 1);
            DrawCentered(g, label, face ?? bold, Color.FromArgb(0x10, 0x0E, 0x06), bounds);
        }
        else
        {
            using (var fill = new SolidBrush(over ? Line : Surface)) g.FillRectangle(fill, bounds);
            using (var pen = new Pen(Line)) g.DrawRectangle(pen, bounds.X, bounds.Y, bounds.Width - 1, bounds.Height - 1);
            DrawCentered(g, label, face ?? font, Ink, bounds);
        }
    }

    private HotSpot AddSpot(Rectangle bounds, string id, Action click, bool primary, string label)
    {
        var spot = new HotSpot { Bounds = bounds, Id = id, Click = click, Primary = primary, Label = label };
        if (hover != null && hover.Id == id && hover.Bounds == bounds) hover = spot;
        spots.Add(spot);
        return spot;
    }

    private static void DrawAt(Graphics g, string text, Font face, Color color, float x, float y)
    {
        using (var brush = new SolidBrush(color)) g.DrawString(text, face, brush, x, y);
    }

    private static void DrawCentered(Graphics g, string text, Font face, Color color, Rectangle bounds)
    {
        using (var brush = new SolidBrush(color))
        using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            g.DrawString(text, face, brush, bounds, format);
    }

    private static void DrawClipped(Graphics g, string text, Font face, Color color, Rectangle bounds)
    {
        if (string.IsNullOrEmpty(text)) return;
        using (var brush = new SolidBrush(color))
        using (var format = new StringFormat { LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            g.DrawString(text, face, brush, bounds, format);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            tick.Dispose();
            if (banner != null) banner.Dispose();
            font.Dispose();
            bold.Dispose();
            big.Dispose();
            title.Dispose();
            symbols.Dispose();
            if (process != null) process.Dispose();
        }
        base.Dispose(disposing);
    }
}
