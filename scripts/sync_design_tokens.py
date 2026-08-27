#!/usr/bin/env python3
"""
sync_design_tokens.py -- estampa design/tokens.css dentro del <style>
de uno o más archivos HTML autocontenidos (el shell, o cualquier
sub-app YA DECODIFICADA a un .html suelto -- ver decode_*.py en el
flujo de trabajo de esta sesión).

Por qué existe: cada archivo de ICOM Salud es HTML autocontenido, sin
build step ni bundler -- no hay forma de "importar" un CSS compartido
sin romper el modo standalone de cada sub-app (ver
auditoría de diseño, 26/08/2026). Este script reemplaza "copiar y
pegar el bloque de tokens a mano en 9 lugares y esperar acordarme de
todos" por un comando -- el archivo sigue siendo 100% autocontenido
(el bloque queda copiado, no importado), sólo que ahora hay una sola
fuente de verdad (design/tokens.css) y una sola forma de propagarla.

Uso:
    python scripts/sync_design_tokens.py archivo1.html [archivo2.html ...]
        Inserta o reemplaza (si ya existe) el bloque de tokens en el
        primer <style> de cada archivo.

    python scripts/sync_design_tokens.py --check archivo1.html [...]
        No escribe nada -- compara el bloque de tokens de cada
        archivo contra design/tokens.css. Sale con código != 0 si
        algún archivo está desincronizado (útil antes de un commit
        que toque tokens.css).

El shell (icom_panel_unificado.html) se puede pasar directo. Los
sub-apps hay que decodificarlos primero (decode_<nombre>.py) y
volver a codificarlos después (reencode_<nombre>.py) -- este script
sólo toca el HTML intermedio, no sabe nada de base64.
"""
import argparse
import io
import pathlib
import re
import sys

# Windows a veces abre stdout en cp1252 -- este script usa acentos y
# los símbolos ✓/✗ en sus mensajes, así que se fuerza UTF-8 acá en vez
# de degradar el mensaje a ASCII.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKENS_PATH = REPO_ROOT / "design" / "tokens.css"

MARK_BEGIN = "/* ICOM_TOKENS:BEGIN -- generado desde design/tokens.css, no editar a mano, correr scripts/sync_design_tokens.py */"
MARK_END = "/* ICOM_TOKENS:END */"

BLOCK_RE = re.compile(
    re.escape(MARK_BEGIN) + r".*?" + re.escape(MARK_END),
    re.DOTALL,
)
STYLE_OPEN_RE = re.compile(r"<style[^>]*>", re.IGNORECASE)


def read_tokens() -> str:
    if not TOKENS_PATH.exists():
        sys.exit(f"No se encontró {TOKENS_PATH}")
    return TOKENS_PATH.read_text(encoding="utf-8").strip("\n")


def build_block(tokens_css: str) -> str:
    return f"{MARK_BEGIN}\n{tokens_css}\n{MARK_END}"


def sync_file(path: pathlib.Path, block: str) -> bool:
    """Devuelve True si el archivo cambió."""
    src = path.read_text(encoding="utf-8")
    if BLOCK_RE.search(src):
        new_src = BLOCK_RE.sub(block.replace("\\", "\\\\"), src, count=1)
    else:
        m = STYLE_OPEN_RE.search(src)
        if not m:
            sys.exit(f"{path}: no se encontró ninguna etiqueta <style> -- no hay dónde insertar")
        insert_at = m.end()
        new_src = src[:insert_at] + "\n" + block + "\n" + src[insert_at:]
    if new_src == src:
        return False
    path.write_text(new_src, encoding="utf-8")
    return True


def check_file(path: pathlib.Path, expected_block: str) -> bool:
    """Devuelve True si está sincronizado."""
    src = path.read_text(encoding="utf-8")
    m = BLOCK_RE.search(src)
    if not m:
        print(f"  ✗ {path}: sin bloque ICOM_TOKENS (nunca se corrió sync)")
        return False
    if m.group(0) != expected_block:
        print(f"  ✗ {path}: bloque desincronizado con design/tokens.css")
        return False
    print(f"  ✓ {path}: sincronizado")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="+", help="archivos .html a estampar/chequear")
    parser.add_argument("--check", action="store_true", help="sólo compara, no escribe")
    args = parser.parse_args()

    tokens_css = read_tokens()
    block = build_block(tokens_css)

    if args.check:
        all_ok = True
        for f in args.files:
            path = pathlib.Path(f)
            if not path.exists():
                print(f"  ✗ {path}: no existe")
                all_ok = False
                continue
            if not check_file(path, block):
                all_ok = False
        sys.exit(0 if all_ok else 1)

    for f in args.files:
        path = pathlib.Path(f)
        if not path.exists():
            sys.exit(f"{path}: no existe")
        changed = sync_file(path, block)
        print(f"  {'✓ actualizado' if changed else '· ya estaba al día'} — {path}")


if __name__ == "__main__":
    main()
