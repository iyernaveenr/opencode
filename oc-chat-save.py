#!/usr/bin/env python3
"""Turn an opencode session export (JSON) into a browsable folder:
  <outdir>/transcript.md    full ordered chat + model/token/context header
  <outdir>/index.html       self-contained render (double-click -> browser)
  <outdir>/attachments/     images/files in order
  <outdir>/metadata.json    raw session info
  <outdir>/.export-manifest.json   tracks written attachments (incremental)
Re-running against the same <outdir> regenerates transcript/html and writes only
NEW attachments (no re-storing from scratch).
Usage: oc_chat_save.py <session.json> <outdir>
"""
import json, sys, os, base64, datetime, html, re

IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

def ts(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S") if ms else ""

def data_url_bytes(url):
    if not isinstance(url, str) or not url.startswith("data:") or ";base64," not in url:
        return None, None
    head, b64 = url.split(";base64,", 1)
    return head[5:], base64.b64decode(b64)

# ---- minimal, dependency-free markdown -> HTML for text parts ----
def _inline(s):
    s = html.escape(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return s

def md_text_to_html(text):
    out = []
    for seg in re.split(r"(```[\s\S]*?```)", text):
        if seg.startswith("```"):
            m = re.match(r"```\w*\n?([\s\S]*?)```", seg)
            out.append("<pre><code>%s</code></pre>" % html.escape(m.group(1) if m else seg.strip("`")))
        else:
            for block in seg.split("\n\n"):
                block = block.strip("\n")
                if not block:
                    continue
                lines = [l for l in block.split("\n")]
                if all(l.lstrip().startswith(("- ", "* ")) for l in lines if l.strip()):
                    out.append("<ul>%s</ul>" % "".join("<li>%s</li>" % _inline(l.lstrip()[2:]) for l in lines if l.strip()))
                else:
                    out.append("<p>%s</p>" % "<br>".join(_inline(l) for l in lines))
    return "\n".join(out)

HTML_STYLE = """body{font:15px/1.6 system-ui,-apple-system,sans-serif;max-width:840px;margin:2rem auto;padding:0 1rem;color:#e8e8ea;background:#1b1b1d}
h1,h2{border-bottom:1px solid #333;padding-bottom:.25em}h2{margin-top:2.2em}
pre{background:#111214;padding:.8em 1em;border-radius:6px;overflow:auto}
code{background:#111214;padding:.1em .35em;border-radius:4px;font-size:.92em}pre code{padding:0;background:none}
img{max-width:100%;border:1px solid #333;border-radius:6px;margin:.4em 0}
table{border-collapse:collapse;margin:.6em 0}td,th{border:1px solid #333;padding:.35em .8em;text-align:left}
blockquote{color:#9aa;border-left:3px solid #444;margin:.4em 0;padding:.1em 1em}
.user{color:#7db3ff}.assistant{color:#8fd694}details{margin:.5em 0}summary{cursor:pointer;color:#bbb}
.att{color:#c9a}"""

def main(json_path, outdir):
    d = json.load(open(json_path))
    info = d["info"]
    att_dir = os.path.join(outdir, "attachments")
    os.makedirs(att_dir, exist_ok=True)

    man_path = os.path.join(outdir, ".export-manifest.json")
    manifest = json.load(open(man_path)) if os.path.exists(man_path) else {"attachments": {}}
    written = manifest["attachments"]
    counter = [len(written)]

    def save_attachment(part_id, mime, filename, raw):
        key = str(part_id)
        if key in written:
            return written[key]
        counter[0] += 1
        name = os.path.basename(filename) if filename else ""
        if not name or "." not in name:
            name = (name or "attachment") + IMG_EXT.get(mime, "")
        fn = "%03d_%s" % (counter[0], name)
        open(os.path.join(att_dir, fn), "wb").write(raw)
        written[key] = fn
        return fn

    # collect (role, blocks) so md and html stay in sync
    m, tok, t = info.get("model", {}), info.get("tokens", {}), info.get("time", {})
    cache = tok.get("cache", {}) or {}
    meta = [
        ("Session", info.get("id")),
        ("Model", "%s/%s (variant: %s)" % (m.get("providerID"), m.get("id"), m.get("variant"))),
        ("Directory", info.get("directory")),
        ("Tokens", "input %s / output %s / reasoning %s / cache r%s w%s" % (
            tok.get("input"), tok.get("output"), tok.get("reasoning"), cache.get("read"), cache.get("write"))),
        ("Cost", "$%s" % info.get("cost")),
        ("Created", ts(t.get("created"))),
        ("Updated", ts(t.get("updated"))),
    ]

    rendered = []
    for msg in d["messages"]:
        role = msg["info"].get("role", "?")
        blocks = []
        for p in msg.get("parts", []):
            pt = p.get("type")
            if pt == "text":
                blocks.append(("note" if p.get("synthetic") else "text", p.get("text", "")))
            elif pt == "file":
                mime, raw = data_url_bytes(p.get("url", ""))
                if raw is not None:
                    fn = save_attachment(p.get("id"), mime, p.get("filename"), raw)
                    blocks.append(("image", (p.get("filename") or fn, fn)))
            elif pt == "tool":
                st = p.get("state", {}) or {}
                blocks.append(("tool", (p.get("tool"), st)))
                for k, att in enumerate(st.get("attachments", []) or []):
                    mime, raw = data_url_bytes(att.get("url", ""))
                    if raw is not None:
                        fn = save_attachment(att.get("id") or "%s_att%d" % (p.get("id"), k),
                                             mime, att.get("filename"), raw)
                        blocks.append(("image", (att.get("filename") or fn, fn)))
        if blocks:
            rendered.append((role, blocks))

    # ---- transcript.md ----
    L = ["# " + str(info.get("title", "opencode session")) + "\n", "| Field | Value |", "|---|---|"]
    L += ["| %s | %s |" % (k, v) for k, v in meta]
    L += ["", "---", ""]
    for role, blocks in rendered:
        L.append({"user": "## User", "assistant": "## Assistant"}.get(role, "## " + role) + "\n")
        for kind, val in blocks:
            if kind == "text":
                L.append(val + "\n")
            elif kind == "note":
                L.append("> _%s_\n" % val)
            elif kind == "image":
                name, fn = val
                L.append("**Attachment: %s**\n" % name)
                L.append("![%s](attachments/%s)\n" % (name, fn))
            elif kind == "tool":
                tool, st = val
                L.append("<details><summary>tool: <code>%s</code> (%s)</summary>\n" % (tool, st.get("status")))
                if st.get("input") is not None:
                    L.append("\nInput:\n```json\n%s\n```\n" % json.dumps(st["input"], indent=2)[:2000])
                if isinstance(st.get("output"), str) and st["output"].strip():
                    L.append("\nOutput:\n```\n%s\n```\n" % st["output"][:2000])
                L.append("</details>\n")
        L.append("\n---\n")
    open(os.path.join(outdir, "transcript.md"), "w").write("\n".join(L))

    # ---- index.html ----
    H = ["<!DOCTYPE html><html><head><meta charset='utf-8'><title>%s</title><style>%s</style></head><body>"
         % (html.escape(str(info.get("title", "chat"))), HTML_STYLE)]
    H.append("<h1>%s</h1>" % html.escape(str(info.get("title", "opencode session"))))
    H.append("<table>" + "".join("<tr><th>%s</th><td>%s</td></tr>" % (html.escape(k), html.escape(str(v))) for k, v in meta) + "</table>")
    for role, blocks in rendered:
        cls = role if role in ("user", "assistant") else "role"
        H.append("<h2 class='%s'>%s</h2>" % (cls, html.escape(role.capitalize())))
        for kind, val in blocks:
            if kind == "text":
                H.append(md_text_to_html(val))
            elif kind == "note":
                H.append("<blockquote>%s</blockquote>" % html.escape(val))
            elif kind == "image":
                name, fn = val
                H.append("<div class='att'>Attachment: %s</div><img src='attachments/%s' alt='%s'>"
                         % (html.escape(name), html.escape(fn), html.escape(name)))
            elif kind == "tool":
                tool, st = val
                H.append("<details><summary>tool: <code>%s</code> (%s)</summary>" % (html.escape(str(tool)), html.escape(str(st.get("status")))))
                if st.get("input") is not None:
                    H.append("<pre><code>%s</code></pre>" % html.escape(json.dumps(st["input"], indent=2)[:2000]))
                if isinstance(st.get("output"), str) and st["output"].strip():
                    H.append("<pre><code>%s</code></pre>" % html.escape(st["output"][:2000]))
                H.append("</details>")
        H.append("<hr>")
    H.append("</body></html>")
    open(os.path.join(outdir, "index.html"), "w").write("\n".join(H))

    json.dump(info, open(os.path.join(outdir, "metadata.json"), "w"), indent=2)
    manifest["attachments"] = written
    json.dump(manifest, open(man_path, "w"), indent=2)
    print("wrote %s : transcript.md + index.html (%d attachment(s))" % (outdir, len(written)))

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: oc_chat_save.py <session.json> <outdir>"); sys.exit(1)
    main(sys.argv[1], sys.argv[2])
