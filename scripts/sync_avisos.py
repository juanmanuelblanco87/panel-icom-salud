# python scripts/sync_avisos.py <archivo.html> [...]
# Inserta (o reemplaza) el bloque de avisos corporativos de design/avisos.html justo antes de </head> en cada archivo.
import sys, re, os
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'design', 'avisos.html')
bloque = open(base, encoding='utf-8').read().strip()
M1, M2 = '<!--icom-avisos:start-->', '<!--icom-avisos:end-->'
nuevo = M1 + '\n' + bloque + '\n' + M2
for ruta in sys.argv[1:]:
    t = open(ruta, encoding='utf-8', newline='').read()
    crlf = '\r\n' in t
    b = nuevo.replace('\n', '\r\n') if crlf else nuevo
    i, j = t.find(M1), t.find(M2)
    if i >= 0 and j > i:
        t = t[:i] + b + t[j + len(M2):]; accion = 'actualizado'
    else:
        k = t.find('</head>')
        if k < 0 or t.find('<body', k) < 0: print('SIN </head> util:', ruta); continue
        t = t[:k] + b + '\n' + t[k:]; accion = 'insertado'
    open(ruta, 'w', encoding='utf-8', newline='').write(t)
    print(accion, os.path.basename(ruta))
