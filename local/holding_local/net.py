"""LAN address, Tailscale HTTPS, and pairing QR codes."""
import io
import json
import platform
import re
import shutil
import socket
import subprocess
import threading
import time
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


CONSENT_URL = re.compile(r"https://login\.tailscale\.com/\S+")


def tailscale_https(port: int, wait: float = 20.0) -> tuple[str | None, str]:
    """Runs `tailscale serve --bg <port>` and returns (https_url, message). Never raises.

    When Serve or HTTPS isn't turned on for the tailnet, `tailscale serve` prints a
    login.tailscale.com link and waits for someone to open it, forever. So we read its
    output for up to `wait` seconds, stop it, and hand that link back in the message.
    Phone access then just isn't on yet; the engine itself starts normally."""
    try:
        return _tailscale_https(port, wait)
    except Exception as e:  # phone access must never stop Holding Local from starting
        return None, f"Tailscale phone access didn't start ({e}). Holding Local works on this computer as usual."


def _tailscale_https(port: int, wait: float) -> tuple[str | None, str]:
    ts = tailscale_bin()
    if not ts:
        return None, "Tailscale is not installed. Get it free at https://tailscale.com/download (also on your phone)."
    try:
        st = json.loads(subprocess.run([ts, "status", "--json"], capture_output=True, text=True, timeout=15).stdout)
    except Exception as e:
        return None, f"Could not read Tailscale status ({e}). Is Tailscale open and signed in?"
    dns = ((st.get("Self") or {}).get("DNSName") or "").rstrip(".")
    if not dns:
        return None, "Tailscale is installed but not signed in. Open Tailscale and sign in, then try again."

    p = subprocess.Popen([ts, "serve", "--bg", str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, text=True)
    out: list[str] = []
    reader = threading.Thread(target=lambda: out.extend(iter(p.stdout.readline, "")), daemon=True)
    reader.start()
    deadline = time.monotonic() + wait
    link = None
    while time.monotonic() < deadline and p.poll() is None:
        m = CONSENT_URL.search("".join(out))
        if m:
            link = m.group(0)
            break
        time.sleep(0.1)
    if p.poll() is None:  # waiting on a consent link, or just stuck
        p.kill()
        p.wait(timeout=5)
    reader.join(timeout=1)
    text = "".join(out).strip()
    link = link or (CONSENT_URL.search(text).group(0) if CONSENT_URL.search(text) else None)
    if link:
        return None, (f"Tailscale phone access needs one approval: open {link} and turn it on "
                      "(it enables Tailscale Serve and HTTPS for your devices), then turn phone access off and on.")
    if p.returncode == 0:
        return f"https://{dns}", "Serving over HTTPS on your tailnet (only your own devices can reach it)."
    if p.returncode is not None and p.returncode < 0:
        return None, (f"Tailscale didn't answer within {int(wait)} seconds, so phone access over Tailscale is off. "
                      "Check that Tailscale is open and connected, then turn phone access off and on.")
    msg = " ".join(text.split()) or f"exit code {p.returncode}"
    return None, ("Tailscale refused to serve HTTPS: " + msg +
                  " If it mentions HTTPS certificates, turn on HTTPS under DNS in the Tailscale admin console.")


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
