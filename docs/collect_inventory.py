"""Catalogue source files and HTTP routes so the handbook stays accurate."""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP = {"node_modules", "dist", ".pgdata", "capture", "docshots", ".git", "raw", "__pycache__"}
EXTS = {".ts", ".tsx", ".mjs", ".js", ".py", ".sql", ".json", ".css", ".html", ".sh", ".service", ".conf", ".yml", ".md"}

inventory: dict[str, int] = {}
for path in sorted(ROOT.rglob("*")):
    rel = path.relative_to(ROOT)
    if any(part in SKIP for part in rel.parts):
        continue
    if not path.is_file() or path.suffix not in EXTS:
        continue
    # The vendored form stylesheets are third-party bulk, not our source.
    if "assets/css" in rel.as_posix() or "form-schema" in rel.as_posix():
        continue
    try:
        lines = len(path.read_text(encoding="utf-8", errors="ignore").splitlines())
    except OSError:
        lines = 0
    inventory[rel.as_posix()] = lines

(ROOT / "docs" / "_inventory.json").write_text(json.dumps(inventory, indent=1), encoding="utf-8")

# ---- HTTP surface, read straight from the controllers ----------------------
HTTP = re.compile(r"@(Get|Post|Put|Patch|Delete)\(\s*'?([^')]*)'?\s*\)")

routes: list[dict] = []
for file in sorted((ROOT / "server" / "src").rglob("*.controller.ts")):
    src = file.read_text(encoding="utf-8")

    # Each @Controller section owns the handlers that follow it.
    sections: list[tuple[str, str]] = []
    marks = list(re.finditer(r"@Controller\('([^']*)'\)", src))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(src)
        sections.append((m.group(1), src[m.start():end]))

    for base, body in sections:
        # Routes are guarded by a named permission (@Requires('team.manage')),
        # not by a list of roles -- reading for the old @Roles here would match
        # nothing and publish every route as unguarded, which is worse than
        # being out of date. A @Requires applied to the class covers every
        # handler inside it.
        head = body[: body.find("{")] if "{" in body else body
        cls = re.search(r"@Requires\(([^)]*)\)", head)
        default_permission = cls.group(1).replace("'", "") if cls else ""

        hits = list(HTTP.finditer(body))
        for i, m in enumerate(hits):
            # Look only between this decorator and the next one, so a later
            # handler's @Requires can never be mistaken for this one's.
            window = body[m.end(): hits[i + 1].start() if i + 1 < len(hits) else len(body)]
            own = re.search(r"@Requires\(([^)]*)\)", window[:220])
            routes.append({
                "method": m.group(1).upper(),
                "path": "/" + "/".join(x for x in [base, m.group(2)] if x),
                "requires": (own.group(1).replace("'", "") if own else default_permission) or "any signed-in",
                "file": f"server/src/{file.relative_to(ROOT / 'server' / 'src').as_posix()}",
            })

(ROOT / "docs" / "_routes.json").write_text(json.dumps(routes, indent=1), encoding="utf-8")

print(f"files: {len(inventory)}  lines: {sum(inventory.values())}  routes: {len(routes)}")
