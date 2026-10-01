using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Stable per-user entry point. Product files live in immutable revision folders.
internal static class ReleaseHost
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    private static string Root;
    private static string StateFile { get { return Path.Combine(Root, "install", "install-state.json"); } }

    private static Dictionary<string, object> Object(object value) { return (Dictionary<string, object>)value; }
    private static Dictionary<string, object> ReadState() { return Object(Json.DeserializeObject(File.ReadAllText(StateFile))); }
    private static Dictionary<string, object> Part(Dictionary<string, object> state, string id) { return Object(Object(state["components"])[id]); }
    private static string PartPath(Dictionary<string, object> state, string id, string key)
    {
        string relative = (string)Object(Part(state, id)["paths"])[key];
        if (Path.IsPathRooted(relative) || relative.Contains(":")) throw new InvalidDataException("Invalid managed path.");
        string path = Path.GetFullPath(Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(Root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Managed path escapes install root.");
        return path;
    }

    private static string Quote(string value)
    {
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { output.Append('\\', slashes * 2 + 1); output.Append('"'); }
            else { output.Append('\\', slashes); output.Append(character); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); output.Append('"');
        return output.ToString();
    }

    private static string Arguments(IEnumerable<string> args)
    {
        var result = new List<string>();
        foreach (string arg in args) result.Add(Quote(arg));
        return string.Join(" ", result.ToArray());
    }

    private static ProcessStartInfo RuntimeEnvironment(Dictionary<string, object> state, string exe, string[] args)
    {
        string app = PartPath(state, "app", "app");
        string python = PartPath(state, "app", "python");
        string git = PartPath(state, "app", "git");
        string saipen = PartPath(state, "saipen", "saipen");
        string saimail = PartPath(state, "saimail", "saimail");
        string data = Environment.GetEnvironmentVariable("ZCODE_DESKTOP_USER_DATA_DIR");
        if (string.IsNullOrWhiteSpace(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ZAICODE");
        Directory.CreateDirectory(data);
        var start = new ProcessStartInfo(exe, Arguments(args)) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root };
        var env = start.EnvironmentVariables;
        env["ZAICODE_INSTALL_ROOT"] = Root;
        env["ZCODE_ZAICODE_MODE"] = "1";
        env["ZCODE_DESKTOP_APPLICATION_NAME"] = "ZAICODE";
        env["ZCODE_DESKTOP_USER_DATA_DIR"] = data;
        env["ZCODE_DESKTOP_SESSION_DATA_DIR"] = Path.Combine(data, "session");
        env["ZAICODE_VERSION"] = (string)state["version"];
        // Honour an existing/custom data root, never migrate by overwriting it.
        string legacyProductHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".zaicode");
        if (string.IsNullOrWhiteSpace(env["ZCODE_DATA_BASE_DIR"])) env["ZCODE_DATA_BASE_DIR"] = Directory.Exists(legacyProductHome) ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) : Path.Combine(data, "data");
        if (string.IsNullOrWhiteSpace(env["ZCODE_HOME"])) env["ZCODE_HOME"] = Directory.Exists(legacyProductHome) ? legacyProductHome : Path.Combine(data, "agent");
        env["SAIPEN_HOME"] = saipen;
        env["ZAICODE_PYTHON"] = Path.Combine(python, "python.exe");
        env["ZAICODE_SAIMAIL_HOME"] = saimail;
        env["ZAICODE_SAIMAIL_CLI"] = Path.Combine(Root, "tools", "saimail-local.exe");
        env["ZAICODE_ROUTER_PACKAGE"] = PartPath(state, "router", "router");
        env["ZAICODE_BASH"] = Path.Combine(git, "bin", "bash.exe");
        env["PATH"] = Path.Combine(Root, "tools") + ";" + Path.Combine(saipen, "bin") + ";" + python + ";" + Path.Combine(git, "cmd") + ";" + Path.Combine(git, "usr", "bin") + ";" + env["PATH"];
        env["PYTHONDONTWRITEBYTECODE"] = "1";
        env["GIT_CONFIG_NOSYSTEM"] = "1";
        return start;
    }

    private static int RunUpdate(string option)
    {
        string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var start = new ProcessStartInfo(ps, "-NoProfile -ExecutionPolicy Bypass -File " + Quote(Path.Combine(Root, "install", "Update-ZAICODE.ps1")) + " -InstallDir " + Quote(Root) + " " + option)
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        using (var process = Process.Start(start))
        {
            string output = process.StandardOutput.ReadToEnd();
            string errors = process.StandardError.ReadToEnd();
            process.WaitForExit();
            if (process.ExitCode != 0) Log("Activation failed: " + output + errors);
            return process.ExitCode;
        }
    }

    private static void Log(string text)
    {
        try
        {
            string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZAICODE", "logs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "launcher.log"), DateTime.UtcNow.ToString("o") + " " + text + Environment.NewLine);
        }
        catch { /* Logging cannot prevent a safe launch. */ }
    }

    private static bool Running(string exe)
    {
        try { using (File.Open(exe, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { return false; } }
        catch (IOException) { return true; }
    }

    private static Process StartChild(ProcessStartInfo start, bool forwardOutput)
    {
        var process = new Process { StartInfo = start };
        if (forwardOutput)
        {
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs output) { if (output.Data != null) Console.Out.WriteLine(output.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs output) { if (output.Data != null) Console.Error.WriteLine(output.Data); };
        }
        process.Start();
        if (forwardOutput) { process.BeginOutputReadLine(); process.BeginErrorReadLine(); }
        return process;
    }

    private static int RunCli(Dictionary<string, object> state, string mode, string[] args)
    {
        string protocolHome = PartPath(state, "saipen", "saipen");
        if (mode == "/saipen")
        {
            string project = Environment.CurrentDirectory;
            for (int index = 0; index + 1 < args.Length; index++) if (args[index] == "--project-root") project = args[index + 1];
            string projectState = Path.Combine(project, ".saipen", "STATE.md");
            if (File.Exists(projectState))
            {
                Match anchor = Regex.Match(File.ReadAllText(projectState), "^saipen_home:\\s*\"?([^\"\\r\\n]+)\"?\\s*$", RegexOptions.Multiline);
                if (anchor.Success)
                {
                    string pinned = Path.GetFullPath(anchor.Groups[1].Value.Trim());
                    string managed = Path.Combine(Root, "managed", "saipen") + "\\";
                    // Retained managed revisions honour the project's canonical binding.
                    // Activating a runtime must never rewrite project history to move it.
                    if (pinned.StartsWith(managed, StringComparison.OrdinalIgnoreCase) && File.Exists(Path.Combine(pinned, "saipen-entry.py"))) protocolHome = pinned;
                }
            }
        }
        string script = mode == "/saipen" ? Path.Combine(protocolHome, "saipen-entry.py") : Path.Combine(PartPath(state, "saimail", "saimail"), "saimail-entry.py");
        var pass = new List<string> { script }; pass.AddRange(args);
        var start = RuntimeEnvironment(state, Path.Combine(PartPath(state, "app", "python"), "python.exe"), pass.ToArray());
        if (mode == "/saipen") start.EnvironmentVariables["SAIPEN_HOME"] = protocolHome;
        // Protocol commands run in the caller's selected project, not the install directory.
        start.WorkingDirectory = Environment.CurrentDirectory;
        using (var process = StartChild(start, true)) { process.WaitForExit(); return process.ExitCode; }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string own = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        Root = Path.GetFileName(own).Equals("tools", StringComparison.OrdinalIgnoreCase) ? Path.GetDirectoryName(own) : own;
        bool cli = args.Length > 0 && (args[0] == "/saipen" || args[0] == "/saimail");
        string name = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
        if (name.Equals("saimail-local", StringComparison.OrdinalIgnoreCase))
        { var prefixed = new List<string> { "/saimail" }; prefixed.AddRange(args); args = prefixed.ToArray(); cli = true; }
        try
        {
            var state = ReadState();
            if (args.Length > 0 && args[0] == "/check-install") return Running(Path.Combine(PartPath(state, "app", "app"), "ZAICODE.exe")) ? 1 : 0;
            if (cli)
            {
                var pass = new List<string>(args); pass.RemoveAt(0);
                return RunCli(state, args[0], pass.ToArray());
            }
            string originalExe = Path.Combine(PartPath(state, "app", "app"), "ZAICODE.exe");
            bool running = Running(originalExe);
            if (!running) { RunUpdate("-Activate"); state = ReadState(); }
            string exe = Path.Combine(PartPath(state, "app", "app"), "ZAICODE.exe");
            var start = RuntimeEnvironment(state, exe, args);
            string activation = Path.Combine(Root, "install", "activation-pending.json");
            string ready = Path.Combine(Root, "install", "activation-ready.txt");
            bool validating = !running && File.Exists(activation);
            if (validating) { if (File.Exists(ready)) File.Delete(ready); start.EnvironmentVariables["ZAICODE_ACTIVATION_READY_FILE"] = ready; }
            using (var process = StartChild(start, Environment.GetEnvironmentVariable("ZAICODE_ACCEPTANCE_HOLD_HOST") == "1"))
            {
                if (!validating) {
                    if (Environment.GetEnvironmentVariable("ZAICODE_ACCEPTANCE_HOLD_HOST") == "1") { process.WaitForExit(); return process.ExitCode; }
                    return 0;
                }
                for (int count = 0; count < 120; count++)
                {
                    if (File.Exists(ready)) {
                        File.Delete(activation); Log("Activated verified release " + state["version"]);
                        if (Environment.GetEnvironmentVariable("ZAICODE_ACCEPTANCE_HOLD_HOST") == "1") { process.WaitForExit(); return process.ExitCode; }
                        return 0;
                    }
                    if (process.HasExited) break;
                    Thread.Sleep(500);
                }
                // A candidate that cannot reach the real main window never becomes known-good.
                if (!process.HasExited) process.Kill();
                RunUpdate("-Rollback");
                Log("Rolled back candidate which did not reach the main window.");
                var previous = ReadState();
                Process.Start(RuntimeEnvironment(previous, Path.Combine(PartPath(previous, "app", "app"), "ZAICODE.exe"), args));
                return 1;
            }
        }
        catch (Exception error)
        {
            Log(error.ToString());
            if (cli) Console.Error.WriteLine(error.Message);
            else MessageBox.Show("ZAICODE could not start. Run the installer again to repair the application.\n\n" + error.Message, "ZAICODE", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
