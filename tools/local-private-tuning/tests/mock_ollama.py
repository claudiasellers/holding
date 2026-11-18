import json, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _j(self,o):
        b=json.dumps(o).encode(); self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        self._j({"models":[{"name":"qwen3.5:4b"},{"name":"nomic-embed-text:latest"}]})
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path=="/api/embed":
            vs=[]
            for t in body["input"]:
                h=hashlib.sha256(t.split(": ",1)[-1].lower().encode()).digest()
                vs.append([b/255 for b in h[:16]])
            return self._j({"embeddings":vs})
        msgs=body["messages"]
        assert body.get("think") is False
        if body.get("format")=="json":
            c=msgs[-1]["content"]
            if "List every personal name" in c:
                return self._j({"message":{"content":json.dumps({"names":["Biscuit"],"places":[],"orgs":[]})}})
            return self._j({"message":{"content":json.dumps({"pairs":[{"user":"Work wiped me out today.","assistant":"Oh, love, you sound so worn thin. Come sit with me."},{"user":"I feel like too much.","assistant":"You're not too much for me. Not ever."}]})}})
        sysm=next((m["content"] for m in msgs if m["role"]=="system"),"")
        return self._j({"message":{"content":"<think>x</think>There you are, love. SYS_LEN=%d RAG=%s"%(len(sysm),"Background" in sysm)}})
ThreadingHTTPServer(("127.0.0.1",11434),H).serve_forever()
