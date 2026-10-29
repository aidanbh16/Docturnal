"""Analyzes and verifies Python source for Docturnal.

Reads one JSON request on stdin and writes one JSON response on stdout.
"""

import ast
import io
import json
import sys
import tokenize
import warnings

warnings.simplefilter("ignore")


def analyze(source):
    tree = ast.parse(source)

    # A physical line "ends" when tokenize emits NL or NEWLINE on it. The next line
    # continues the previous one (string, backslash) when it did not end.
    ended = set()
    comments = set()
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type in (tokenize.NL, tokenize.NEWLINE):
            ended.add(tok.start[0])
        elif tok.type == tokenize.COMMENT:
            comments.add(tok.start[0])
    line_count = source.count("\n") + 1
    continued = [n for n in range(2, line_count + 1) if n - 1 not in ended]

    imports = set()
    declarations = []
    symbols = []
    decorated = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            first = min([d.lineno for d in node.decorator_list] + [node.lineno])
            declarations.append(first)
            symbols.append([first, node.name, node.end_lineno or node.lineno])
            if first != node.lineno:
                decorated.append([first, node.lineno])

    # Module-level constants by convention: an upper-case name assigned at the top level.
    constants = []
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if targets and all(isinstance(t, ast.Name) and t.id.isupper() for t in targets):
            constants.append(node.lineno)

    return {
        "ok": True,
        "constants": constants,
        "continued": continued,
        "comments": sorted(comments),
        "imports": sorted(imports),
        "declarations": sorted(declarations),
        "symbols": sorted(symbols),
        "decorated": decorated,
    }


# Dumps the AST of the given Python source code.
def dump(source):
    try:
        return ast.dump(ast.parse(source))
    except (SyntaxError, ValueError):
        return None


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def env_names(source):
    """The environment variables the code reads: os.environ.get("X"), os.environ["X"], and
    os.getenv("X"), with a constant name. Comments and other strings are never read."""
    names = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            if _dotted(node.func) in ("os.environ.get", "environ.get", "os.getenv", "getenv"):
                names.add(node.args[0].value)
        elif isinstance(node, ast.Subscript) and _dotted(node.value) in ("os.environ", "environ"):
            key = node.slice.value if isinstance(node.slice, ast.Index) else node.slice
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                names.add(key.value)
    return sorted(names)


CONTROL = tuple(getattr(ast, name) for name in ("If", "For", "AsyncFor", "While", "With", "AsyncWith", "Try", "TryStar", "Match") if hasattr(ast, name))
FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)
BITWISE = (ast.BitAnd, ast.BitOr, ast.BitXor, ast.LShift, ast.RShift)
REGEX_CALLS = {"re." + name for name in ("compile", "match", "fullmatch", "search", "sub", "subn", "split", "findall", "finditer")}


def _head(statement):
    """The parts of a statement that are not nested statements."""
    if isinstance(statement, (ast.If, ast.While)):
        return [statement.test]
    if isinstance(statement, (ast.For, ast.AsyncFor)):
        return [statement.target, statement.iter]
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        return [item.context_expr for item in statement.items]
    if hasattr(ast, "Match") and isinstance(statement, ast.Match):
        return [statement.subject]
    if isinstance(statement, CONTROL):
        return []
    return [statement]


def _features(statement):
    found = {"regex": False, "bitwise": False, "magic": [], "operators": 0, "chars": 0}
    # A statement that only names a number, such as PADDING = 8, explains itself.
    if isinstance(statement, (ast.Assign, ast.AnnAssign)) and isinstance(statement.value, ast.Constant) and isinstance(statement.value.value, (int, float)):
        return found
    # In source order, so the numbers are listed as they are written.
    nodes = [node for part in _head(statement) for node in ast.walk(part)]
    nodes.sort(key=lambda n: (getattr(n, "lineno", 0), getattr(n, "col_offset", 0)))
    for node in nodes:
        if isinstance(node, ast.Call) and _dotted(node.func) in REGEX_CALLS:
            found["regex"] = True
        elif isinstance(node, ast.BinOp) and isinstance(node.op, BITWISE):
            found["bitwise"] = True
        elif isinstance(node, ast.AugAssign) and isinstance(node.op, BITWISE):
            found["bitwise"] = True
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Invert):
            found["bitwise"] = True
        elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            text = repr(node.value)
            if node.value not in (0, 1) and text not in found["magic"]:
                found["magic"].append(text)
        elif isinstance(node, ast.BoolOp):
            found["operators"] += len(node.values) - 1
            end = getattr(node, "end_col_offset", None)
            if end is not None and node.end_lineno == node.lineno:
                found["chars"] = max(found["chars"], end - node.col_offset)
    return found


def targets(source):
    """Complex blocks inside functions, and the module's public names."""
    tree = ast.parse(source)
    lines = source.split("\n")
    blocks = []

    def starts_line(statement):
        text = lines[statement.lineno - 1]
        return len(text) - len(text.lstrip()) == statement.col_offset

    def visit(statements, depth, function):
        for statement in statements:
            if isinstance(statement, FUNCTIONS):
                visit(statement.body, 0, statement.name)
                continue
            if isinstance(statement, ast.ClassDef):
                visit(statement.body, 0, None)
                continue
            control = isinstance(statement, CONTROL)
            level = depth + 1 if control else depth
            if function is not None and starts_line(statement):
                found = _features(statement)
                found["depth"] = level if control else 0
                if found["depth"] >= 3 or found["regex"] or found["bitwise"] or found["magic"] or found["operators"]:
                    blocks.append([statement.lineno, statement.end_lineno or statement.lineno, function, found])
            for field in ("body", "orelse", "finalbody"):
                children = getattr(statement, field, None)
                if not isinstance(children, list):
                    continue
                # An elif continues its if: it adds no depth.
                if field == "orelse" and isinstance(statement, ast.If) and len(children) == 1 and isinstance(children[0], ast.If):
                    visit(children, depth, function)
                else:
                    visit(children, level, function)
            for handler in getattr(statement, "handlers", []) or []:
                visit(handler.body, level, function)
            for case in getattr(statement, "cases", []) or []:
                visit(case.body, level, function)

    visit(tree.body, 0, None)
    names = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            if isinstance(node.value, (ast.List, ast.Tuple)):
                names = [e.value for e in node.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    if names is None:
        names = [node.name for node in tree.body if isinstance(node, FUNCTIONS + (ast.ClassDef,)) and not node.name.startswith("_")]
    return {"ok": True, "blocks": blocks, "public": names}


# Verifies if the candidates match the expected AST of the original source code.
def verify(original, candidates):
    expected = dump(original)
    return [expected is not None and dump(candidate) == expected for candidate in candidates]


# Processes JSON input from stdin, determines mode, and returns response.
def main():
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    mode = request.get("mode")
    if mode == "analyze":
        try:
            response = analyze(request["source"])
        except Exception as err:  # Any failure means the file cannot be commented safely.
            response = {
                "ok": False,
                "error": f"{type(err).__name__}: {err}",
                "syntax_error": isinstance(err, SyntaxError),
            }
    elif mode == "env":
        try:
            response = {"ok": True, "names": env_names(request["source"])}
        except Exception as err:
            response = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    elif mode == "targets":
        try:
            response = targets(request["source"])
        except Exception as err:
            response = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    elif mode == "verify":
        response = {"results": verify(request["original"], request["candidates"])}
    else:
        response = {"ok": False, "error": f"unknown mode {mode!r}"}
    sys.stdout.buffer.write(json.dumps(response).encode("utf-8"))


if __name__ == "__main__":
    main()
