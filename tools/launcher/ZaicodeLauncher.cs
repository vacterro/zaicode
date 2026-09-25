// ZAICODE root launcher: double-click ZAICODE.exe in the workspace root.
// Starts the packaged app in ZAICODE mode (no console window), points it at
// the SAIPEN install, and restarts it after a crash unless disabled in
// %APPDATA%\ZAICODE\zaicode-launcher.json ({"autoRestartOnCrash": false}).
// Staged updates: `pnpm bundle:zaicode` builds into dist-next while the app
// runs; the launcher swaps dist-next into dist before starting the app.
// Build: tools\launcher\build.cmd
using System;
using System.Diagnostics;
using System.IO;
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
        ApplyStagedBuild(workspace);
        if (!File.Exists(executable))
        {
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
                    process.WaitForExit();
                    exitCode = process.ExitCode;
                }
            }
            catch (Exception error)
            {
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

    private static void Log(string message)
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
