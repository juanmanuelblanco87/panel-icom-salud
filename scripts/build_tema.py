# python scripts/build_tema.py -> arma design/tema.html (script + estilos) concatenando design/tema/tema.js.html, design/tema/iconos_motor.js (dentro del mismo <script>) y design/tema/*.css (en orden alfabético)
import os, glob
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'design')
js = open(os.path.join(base, 'tema', 'tema.js.html'), encoding='utf-8').read().rstrip()
motor = open(os.path.join(base, 'tema', 'iconos_motor.js'), encoding='utf-8').read().rstrip()
assert js.endswith('</script>')
js = js[:-len('</script>')].rstrip() + '\n' + motor + '\n</script>\n'
css = ''.join(open(f, encoding='utf-8').read().rstrip() + '\n\n' for f in sorted(glob.glob(os.path.join(base, 'tema', '*.css'))))
open(os.path.join(base, 'tema.html'), 'w', encoding='utf-8').write(js + '<style id="icomTemaCss">\n' + css + '</style>\n')
print('tema.html armado:', len(css), 'bytes de CSS')
