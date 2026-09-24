// ZAICODE root launcher: double-click ZAICODE.exe in the workspace root.
// Starts the packaged app in ZAICODE mode (no console window), points it at
// the SAIPEN install, and restarts it after a crash unless disabled in
// %APPDATA%\ZAICODE\zaicode-launcher.json ({"autoRestartOnCrash": false}).
// Build: tools\launcher\build.cmd
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal static class ZaicodeLauncher
{
    private const string AppRelativePath = @"zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe";
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
        if (!File.Exists(executable))
        {
            Log("ZAICODE.exe missing: " + executable);
            MessageBox.Show(
                "ZAICODE app build is missing:\n" + executable +
                "\n\nBuild it from zcode\\ with: pnpm bundle:zaicode",
                "ZAICODE launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 2;
        }

        Environment.SetEnvironmentVariable("ZCODE_ZAICODE_MODE", "1");
        Environment.SetEnvironmentVariable("ZCODE_ZAICODE_IDENTITY", "1");
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SAIPEN_HOME")))
        {
            string saipenHome = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"saipen\scheduled-source");
            if (File.Exists(Path.Combine(saipenHome, @"bin\saipen.cmd")))
                Environment.SetEnvironmentVariable("SAIPEN_HOME", saipenHome);
        }

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

    private static string Quote(string value)
    {
        return value.IndexOfAny(new[] { ' ', '"' }) < 0 ? value : "\"" + value.Replace("\"", "\\\"") + "\"";
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
