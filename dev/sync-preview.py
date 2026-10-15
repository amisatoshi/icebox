"""Regenerates dev/preview.html from ui/index.html. Run after changing index.html:
    python3 dev/sync-preview.py
"""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent
src = (root / "ui" / "index.html").read_text()
body = re.search(r"<body>(.*?)<script src=\"demo.js\"></script>", src, re.S).group(1)
body = body.replace('src="icon.png"', 'src="../ui/icon.png"')
html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Icebox (UI preview with fake devices)</title>
  <link rel="stylesheet" href="../ui/style.css">
</head>
<body>
  <!-- Generated from ui/index.html by dev/sync-preview.py. Runs the UI in a normal browser
       against the demo backend, with extra devices showing the warning states. -->
{body.strip()}
  <script src="../ui/demo.js"></script>
  <script src="mock-tauri.js"></script>
  <script src="../ui/app.js"></script>
</body>
</html>
"""
(root / "dev" / "preview.html").write_text(html)
print("wrote dev/preview.html")
