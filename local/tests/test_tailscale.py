"""Phone access over Tailscale must never stop Holding Local from starting."""
import json
import stat
import time

from holding_local import net

STATUS = json.dumps({"Self": {"DNSName": "mac.tail1234.ts.net."}})


def fake_tailscale(tmp_path, monkeypatch, serve: str):
    """A stand-in `tailscale`: `status --json` answers; `serve` runs the given shell."""
    exe = tmp_path / "tailscale"
    exe.write_text(f"""#!/bin/sh
if [ "$1" = status ]; then echo '{STATUS}'; exit 0; fi
{serve}
""")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(net, "tailscale_bin", lambda: str(exe))


def test_serve_ok(tmp_path, monkeypatch):
    fake_tailscale(tmp_path, monkeypatch, "echo 'Available within your tailnet'; exit 0")
    url, msg = net.tailscale_https(8787, wait=5)
    assert url == "https://mac.tail1234.ts.net" and "HTTPS" in msg


def test_serve_waiting_on_approval_returns_the_link(tmp_path, monkeypatch):
    # What `tailscale serve` does when Serve isn't enabled on the tailnet: print a link, then wait forever.
    fake_tailscale(tmp_path, monkeypatch,
                   "echo 'Serve is not enabled on your tailnet.'; echo 'To enable, visit:'; "
                   "echo; echo '         https://login.tailscale.com/f/serve?node=abc123'; sleep 300")
    t = time.monotonic()
    url, msg = net.tailscale_https(8787, wait=10)
    assert url is None and time.monotonic() - t < 8
    assert "https://login.tailscale.com/f/serve?node=abc123" in msg and "\n" not in msg


def test_serve_hangs_silently(tmp_path, monkeypatch):
    fake_tailscale(tmp_path, monkeypatch, "sleep 300")
    t = time.monotonic()
    url, msg = net.tailscale_https(8787, wait=1)
    assert url is None and "didn't answer" in msg and time.monotonic() - t < 5


def test_serve_error(tmp_path, monkeypatch):
    fake_tailscale(tmp_path, monkeypatch, "echo 'HTTPS certificates are not enabled' >&2; exit 1")
    url, msg = net.tailscale_https(8787, wait=5)
    assert url is None and "HTTPS certificates are not enabled" in msg


def test_never_raises(monkeypatch):
    monkeypatch.setattr(net, "tailscale_bin", lambda: (_ for _ in ()).throw(OSError("boom")))
    url, msg = net.tailscale_https(8787)
    assert url is None and "boom" in msg
