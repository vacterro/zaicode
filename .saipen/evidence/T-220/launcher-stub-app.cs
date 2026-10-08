// Stand-in for the packaged app in the launcher acceptance: a real GUI process that
// records that it was started from the promoted package, then exits on a stop flag.
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

internal static class StubApp
{
    [STAThread]
    private static void Main()
    {
        string here = AppDomain.CurrentDomain.BaseDirectory;
        File.WriteAllText(
            Path.Combine(here, "started.txt"),
            DateTime.UtcNow.ToString("o") + "|" + System.Diagnostics.Process.GetCurrentProcess().Id + "|" + here);
        Application.EnableVisualStyles();
        using (Form form = new Form())
        {
            form.Text = "T220 STUB APP";
            form.ClientSize = new Size(320, 120);
            Label label = new Label { Text = "stand-in app for the launcher gate", AutoSize = true, Left = 12, Top = 12 };
            form.Controls.Add(label);
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
            timer.Interval = 500;
            timer.Tick += delegate
            {
                if (!File.Exists(Path.Combine(here, "stop.flag"))) return;
                timer.Stop();
                form.Close();
            };
            timer.Start();
            Application.Run(form);
        }
    }
}