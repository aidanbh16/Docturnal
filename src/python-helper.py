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


def dump(source):
    try:
        return ast.dump(ast.parse(source))
    except (SyntaxError, ValueError):
        return None


def verify(original, candidates):
    expected = dump(original)
    return [expected is not None and dump(candidate) == expected for candidate in candidates]


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
    elif mode == "verify":
        response = {"results": verify(request["original"], request["candidates"])}
    else:
        response = {"ok": False, "error": f"unknown mode {mode!r}"}
    sys.stdout.buffer.write(json.dumps(response).encode("utf-8"))


if __name__ == "__main__":
    main()
