# Generate icon resources from the user-designed source image (icon.png at project root).
# Output: resources/tray.png(32), resources/icon.png(512), resources/icon.ico(16-256 multi-size PNG-in-ICO).
# Pure ASCII to avoid PowerShell 5.1 ANSI encoding issues.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;

public static class IconGen2
{
    // Scale source image onto a square canvas of the given size, preserving aspect ratio and centering.
    static Bitmap ScaleTo(Image src, int size)
    {
        var bmp = new Bitmap(size, size);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Color.Transparent);
            float ratio = Math.Min((float)size / src.Width, (float)size / src.Height);
            float w = src.Width * ratio;
            float h = src.Height * ratio;
            float x = ((float)size - w) / 2f;
            float y = ((float)size - h) / 2f;
            g.DrawImage(src, new RectangleF(x, y, w, h));
        }
        return bmp;
    }

    static byte[] ToPng(Bitmap bmp)
    {
        using (var ms = new MemoryStream())
        {
            bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            return ms.ToArray();
        }
    }

    public static void Generate(string sourcePath, string dir)
    {
        Directory.CreateDirectory(dir);
        int[] icoSizes = { 16, 24, 32, 48, 64, 128, 256 };
        var pngs = new System.Collections.Generic.List<byte[]>();
        using (var srcImg = Image.FromFile(sourcePath))
        {
            foreach (int s in icoSizes)
            {
                using (var b = ScaleTo(srcImg, s)) pngs.Add(ToPng(b));
            }
            using (var t32 = ScaleTo(srcImg, 32)) File.WriteAllBytes(Path.Combine(dir, "tray.png"), ToPng(t32));
            using (var t512 = ScaleTo(srcImg, 512)) File.WriteAllBytes(Path.Combine(dir, "icon.png"), ToPng(t512));
        }

        // Multi-size PNG-in-ICO container: 256 recorded as 0 in the directory entry.
        using (var ms = new MemoryStream())
        using (var bw = new BinaryWriter(ms))
        {
            bw.Write((ushort)0); bw.Write((ushort)1); bw.Write((ushort)pngs.Count);
            uint offset = (uint)(6 + 16 * pngs.Count);
            for (int i = 0; i < pngs.Count; i++)
            {
                int s = icoSizes[i];
                byte w = s >= 256 ? (byte)0 : (byte)s;
                bw.Write(w); bw.Write(w);
                bw.Write((byte)0); bw.Write((byte)0);
                bw.Write((ushort)1); bw.Write((ushort)32);
                bw.Write((uint)pngs[i].Length);
                bw.Write(offset);
                offset += (uint)pngs[i].Length;
            }
            foreach (byte[] p in pngs) bw.Write(p);
            bw.Flush();
            File.WriteAllBytes(Path.Combine(dir, "icon.ico"), ms.ToArray());
        }
    }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'icon.png'
if (-not (Test-Path $sourcePath)) { throw "Source icon not found: $sourcePath" }
$resDir = Join-Path $root 'resources'
[IconGen2]::Generate($sourcePath, $resDir)

Write-Host 'Icons generated:'
Get-ChildItem $resDir -Include icon.ico, icon.png, tray.png -Recurse | ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.Name, $_.Length) }
