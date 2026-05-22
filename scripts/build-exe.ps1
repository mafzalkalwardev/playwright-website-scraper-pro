param(
  [string]$ReleaseDir = "release",
  [string]$AppName = "WebsiteScraper"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releasePath = Join-Path $root $ReleaseDir
$stagePath = Join-Path $releasePath "stage"
$exePath = Join-Path $releasePath "$AppName.exe"
$payloadPath = Join-Path $releasePath "payload.zip"
$stubPath = Join-Path $releasePath "SelfExtractor.cs"
$nodePath = (Get-Command node).Source
$browserPath = Join-Path $env:LOCALAPPDATA "ms-playwright"
$cscPath = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (!(Test-Path $browserPath)) {
  throw "Playwright browsers were not found at $browserPath. Run: npx playwright install chromium"
}

if (!(Test-Path $cscPath)) {
  throw "C# compiler was not found at $cscPath."
}

if (Test-Path $stagePath) {
  Remove-Item -LiteralPath $stagePath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagePath, $releasePath | Out-Null

Copy-Item -LiteralPath $nodePath -Destination (Join-Path $stagePath "node.exe") -Force
Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $stagePath -Force
Copy-Item -LiteralPath (Join-Path $root "package-lock.json") -Destination $stagePath -Force
Copy-Item -LiteralPath (Join-Path $root "server.js") -Destination $stagePath -Force
Copy-Item -LiteralPath (Join-Path $root "Scraper.js") -Destination $stagePath -Force
Copy-Item -LiteralPath (Join-Path $root "public") -Destination (Join-Path $stagePath "public") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $root "node_modules") -Destination (Join-Path $stagePath "node_modules") -Recurse -Force
Copy-Item -LiteralPath $browserPath -Destination (Join-Path $stagePath "ms-playwright") -Recurse -Force

if (Test-Path $payloadPath) {
  Remove-Item -LiteralPath $payloadPath -Force
}
Compress-Archive -Path (Join-Path $stagePath "*") -DestinationPath $payloadPath -Force

$stub = @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

class SelfExtractor
{
    [STAThread]
    static void Main()
    {
        try
        {
            string appName = "WebsiteScraper";
            string installRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                appName,
                "app");
            string dataRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                appName);

            Directory.CreateDirectory(dataRoot);
            if (Directory.Exists(installRoot))
                Directory.Delete(installRoot, true);
            Directory.CreateDirectory(installRoot);

            string resourceName = Assembly.GetExecutingAssembly()
                .GetManifestResourceNames()
                .First(name => name.EndsWith("payload.zip", StringComparison.OrdinalIgnoreCase));
            string zipPath = Path.Combine(Path.GetTempPath(), appName + "-payload.zip");

            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            using (FileStream output = File.Create(zipPath))
                input.CopyTo(output);

            ZipFile.ExtractToDirectory(zipPath, installRoot);

            string nodePath = Path.Combine(installRoot, "node.exe");
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = nodePath;
            info.Arguments = "server.js";
            info.WorkingDirectory = installRoot;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.EnvironmentVariables["SCRAPER_HOME"] = dataRoot;
            info.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = Path.Combine(installRoot, "ms-playwright");
            info.EnvironmentVariables["SCRAPER_OPEN_BROWSER"] = "1";

            Process.Start(info);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.ToString(), "Website Scraper failed to start");
        }
    }
}
'@

Set-Content -LiteralPath $stubPath -Value $stub -Encoding ASCII

if (Test-Path $exePath) {
  Remove-Item -LiteralPath $exePath -Force
}

& $cscPath /nologo /target:winexe /out:$exePath /resource:$payloadPath,payload.zip /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Windows.Forms.dll $stubPath

if (!(Test-Path $exePath)) {
  throw "$exePath was not created."
}

Write-Host "Created $exePath"
Write-Host "Scraped files on the other computer will be saved in Documents\$AppName."
