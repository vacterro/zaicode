// ZAICODE-Setup.exe: the one-click installer. It carries install\*.ps1 as
// resources, unpacks them into a temporary folder and runs Install-ZAICODE.ps1
// with Windows PowerShell in this console, so the person sees every step.
// Arguments pass through (for example -InstallDir D:\ZAICODE).
// Build: install\setup\build.cmd
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class ZaicodeSetup
{
    private static readonly string[] Scripts =
    {
        "Install-ZAICODE.ps1", "ZaicodeInstallLib.ps1", "ZaicodeChecks.ps1", "ZAICODE-Doctor.ps1",
    };

    private static int Main(string[] args)
    {
        Console.Title = "ZAICODE setup";
        string folder = Path.Combine(Path.GetTempPath(), "zaicode-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(folder);
        Assembly assembly = Assembly.GetExecutingAssembly();
        foreach (string name in Scripts)
        {
            using (Stream source = assembly.GetManifestResourceStream(name))
            using (FileStream target = File.Create(Path.Combine(folder, name)))
            {
                if (source == null) throw new InvalidOperationException("missing resource " + name);
                source.CopyTo(target);
            }
        }

        string[] quoted = Array.ConvertAll(args, Quote);
        var info = new ProcessStartInfo("powershell.exe")
        {
            Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(Path.Combine(folder, "Install-ZAICODE.ps1")) +
                (quoted.Length > 0 ? " " + string.Join(" ", quoted) : ""),
            UseShellExecute = false,
        };
        int code;
        using (Process process = Process.Start(info))
        {
            process.WaitForExit();
            code = process.ExitCode;
        }
        Console.WriteLine();
        Console.WriteLine(code == 0 ? "ZAICODE is installed. Press Enter to close." : "Setup did not finish. Press Enter to close.");
        Console.ReadLine();
        try { Directory.Delete(folder, true); } catch { /* temp folder only */ }
        return code;
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
