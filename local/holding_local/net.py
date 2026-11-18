"""LAN address, Tailscale HTTPS, and pairing QR codes."""
import io
import json
import platform
import shutil
import socket
import subprocess
from pathlib import Path

import qrcode
import qrcode.image.svg


def lan_ip() -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the outgoing interface
        ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None
    finally:
        s.close()


def tailscale_bin() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    mac = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
    if platform.system() == "Darwin" and mac.exists():
        return str(mac)
    return None


def tailscale_https(port: int) -> tuple[str | None, str]:
    """Runs `tailscale serve --bg <port>` and returns (https_url, message)."""
    ts = tailscale_bin()
    if not ts:
        return None, "Tailscale is not installed. Get it free at https://tailscale.com/download (also on your phone)."
    try:
        st = json.loads(subprocess.run([ts, "status", "--json"], capture_output=True, text=True, timeout=15).stdout)
    except Exception as e:
        return None, f"Could not read Tailscale status ({e}). Is Tailscale signed in?"
    dns = ((st.get("Self") or {}).get("DNSName") or "").rstrip(".")
    if not dns:
        return None, "Tailscale is installed but not signed in. Open Tailscale and sign in, then try again."
    p = subprocess.run([ts, "serve", "--bg", str(port)], capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        msg = (p.stderr or p.stdout).strip()
        return None, ("Tailscale refused to serve HTTPS: " + msg +
                      "\nIf it mentions HTTPS certificates, enable 'HTTPS' under DNS in the Tailscale admin console.")
    return f"https://{dns}", "Serving over HTTPS on your tailnet (only your own devices can reach it)."


def pair_url(base: str, token: str) -> str:
    return f"{base.rstrip('/')}/#pair={token}"


def qr_ascii(data: str) -> str:
    q = qrcode.QRCode(border=1)
    q.add_data(data)
    q.make(fit=True)
    buf = io.StringIO()
    q.print_ascii(out=buf, invert=True)
    return buf.getvalue()


def qr_svg(data: str) -> bytes:
    img = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage, box_size=12, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return buf.getvalue()
