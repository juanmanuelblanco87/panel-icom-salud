/* ── Íconos de línea (tema nuevo): reemplazan los emojis de la interfaz por trazos sobrios del color del texto. ──
   El emoji queda en el texto (se puede copiar y los textos no cambian para el resto del código): sólo se oculta y se dibuja encima un ícono con CSS mask.
   Sólo se tocan los emojis "de interfaz" de la tabla; caritas, manos, corazones y demás (chat, mensajes, selector de emojis del correo) no se tocan. */
(function(){
  if(document.documentElement.getAttribute('data-tema') !== 'nuevo') return;
  var P = {
    'alert':'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    'alert-circle':'<circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.5h.01"/>',
    'box':'<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3.3 7.5 12 12l8.7-4.5M12 12v9"/>',
    'check-circle':'<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    'check':'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    'x-circle':'<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    'radio':'<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
    'pencil':'<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/><path d="M14 7l3 3"/>',
    'bolt':'<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    'download':'<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    'arrow-up':'<path d="M12 20V5M6 11l6-6 6 6"/>',
    'trash':'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    'refresh':'<path d="M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5"/>',
    'dollar':'<path d="M12 3v18M16 7.5C15 6.5 13.7 6 12 6c-2.2 0-4 1-4 2.8 0 4 8 2 8 6.2 0 1.8-1.8 3-4 3-1.8 0-3.2-.6-4.2-1.7"/>',
    'clipboard':'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/>',
    'calendar':'<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    'info':'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    'bag':'<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
    'cross':'<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M12 9v6M9 12h6"/>',
    'user':'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
    'users':'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-5.5 6.5-5.5s6.5 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2.3.6 3.5 2.2 3.5 5.2"/>',
    'hourglass':'<path d="M6 3h12M6 21h12M7 3c0 5 3 6 5 9-2 3-5 4-5 9M17 3c0 5-3 6-5 9 2 3 5 4 5 9"/>',
    'tag':'<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1"/>',
    'shuffle':'<path d="M3 7h4c4 0 6 10 10 10h4M3 17h4c1.5 0 2.7-1.2 3.7-2.7M14 8.5C15 7.5 16 7 17 7h4M18 4l3 3-3 3M18 14l3 3-3 3"/>',
    'wheelchair':'<circle cx="12" cy="4.5" r="1.8"/><path d="M12 8v6h5l2 5M12 11h5M8.5 12a5 5 0 1 0 6 7.5"/>',
    'search':'<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    'camera':'<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4V8z"/><circle cx="12" cy="13" r="3.5"/>',
    'star':'<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.3-4.1 5.9-.9L12 3.5z"/>',
    'folder':'<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12z"/>',
    'store':'<path d="M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3"/><path d="M10 20v-5h4v5"/>',
    'building':'<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7.5h2M13 7.5h2M9 11.5h2M13 11.5h2M10 21v-4h4v4"/>',
    'syringe':'<path d="M18 3l3 3M15 6l3 3M14 7L5 16v3h3l9-9M9 12l3 3M3 21l3-3"/>',
    'phone':'<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    'message':'<path d="M4 5h16v11H9l-5 4V5z"/>',
    'pin':'<path d="M12 21s7-6 7-11.5a7 7 0 0 0-14 0C5 15 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    'sliders':'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    'sun':'<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
    'film':'<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M16 5v14M3.5 9.5H8M16 9.5h4.5M3.5 14.5H8M16 14.5h4.5"/>',
    'bars':'<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
    'trend':'<path d="M3 17l6-6 4 4 8-9M15 6h6v6"/>',
    'globe':'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    'activity':'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    'save':'<path d="M5 4h11l3 3v13H5V4z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    'mail':'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
    'briefcase':'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2M3 13h18"/>',
    'wallet':'<path d="M4 7a2 2 0 0 1 2-2h12v4M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
    'ship':'<path d="M3 17l2 3h14l2-3-9-3-9 3zM12 14V4M12 6l5 4h-5M12 8L8 11h4"/>',
    'cart':'<path d="M3 4h2.5l2 11h10l2-8H7"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/>',
    'arrow-ur':'<path d="M7 17L17 7M8 7h9v9"/>',
    'undo':'<path d="M9 7L4 12l5 5M4 12h10a6 6 0 0 1 6 6"/>',
    'arrows-v':'<path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/>',
    'printer':'<path d="M7 9V3.5h10V9M7 17H4.5V9h15v8H17M7 14h10v6.5H7V14z"/>',
    'image':'<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
    'target':'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    'trophy':'<path d="M8 4h8v6a4 4 0 0 1-8 0V4zM8 6H4v2a3 3 0 0 0 4 3M16 6h4v2a3 3 0 0 1-4 3M12 14v4M8.5 20h7"/>',
    'ban':'<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    'tri-down':'<path d="M5 8h14l-7 10z"/>',
    'compass':'<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/>',
    'map':'<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6zM9 4v14M15 6v14"/>',
    'bot':'<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5M9 13.5h.01M15 13.5h.01M9.5 16.5h5"/>',
    'ruler':'<path d="M3 17L17 3l4 4L7 21l-4-4zM7 13l2 2M10 10l2 2M13 7l2 2"/>',
    'palette':'<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2-.6-1.2.2-2.5 1.6-2.5H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16" cy="11" r="1"/>',
    'megaphone':'<path d="M4 10v4h3l8 4V6L7 10H4zM18 9a4 4 0 0 1 0 6"/>',
    'clock':'<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M5 4L3 6M19 4l2 2"/>',
    'coffee':'<path d="M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9zM16 10h2a2.5 2.5 0 0 1 0 5h-2M8 4v2M12 4v2"/>',
    'gift':'<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8c-2 0-4-1-4-2.5S10 3 12 5c2-2 4-1 4 .5S14 8 12 8z"/>',
    'sparkles':'<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"/>',
    'bulb':'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    'link':'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    'file':'<path d="M6 3h8l5 5v13H6V3zM14 3v5h5M9 13h6M9 17h6"/>',
    'pause':'<path d="M8 5v14M16 5v14"/>',
    'truck':'<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
    'scale':'<path d="M12 4v16M6 20h12M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0L5 7zM19 7l-3 7a3.5 3.5 0 0 0 6 0l-3-7z"/>',
    'power':'<path d="M12 3v9M6.4 6.8a8 8 0 1 0 11.2 0"/>',
    'help':'<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>'
  };
  // emoji -> ícono (sin el selector de variación U+FE0F, que se acepta de forma opcional)
  var M = {
    '⚠':'alert','🚨':'alert-circle','📦':'box','🧊':'box','✅':'check-circle','✔':'check','☑':'check','❌':'x-circle',
    '📡':'radio','✏':'pencil','📝':'pencil','⚡':'bolt','⬇':'download','⬆':'arrow-up','🗑':'trash','🔄':'refresh',
    '💲':'dollar','📋':'clipboard','📅':'calendar','🗓':'calendar','ℹ':'info','🤝':'bag','🏥':'cross',
    '🧑‍💼':'user','👥':'users','⏳':'hourglass','🏷':'tag','🔀':'shuffle','♿':'wheelchair',
    '🔍':'search','🔎':'search','🔭':'search','📷':'camera','🎂':'gift','🎁':'gift','⭐':'star',
    '🗂':'folder','📂':'folder','🏪':'store','🏬':'building','🏢':'building','🏭':'building',
    '💉':'syringe','📞':'phone','💬':'message','📍':'pin','📌':'pin','⚙':'sliders','🏖':'sun','☀':'sun',
    '🎬':'film','📊':'bars','📈':'trend','🌐':'globe','🩺':'activity','💾':'save','✉':'mail',
    '💼':'briefcase','💰':'wallet','🚢':'ship','🛒':'cart','↗':'arrow-ur','↩':'undo','↕':'arrows-v',
    '🖨':'printer','🖼':'image','🎯':'target','🏆':'trophy','🚫':'ban','⛔':'ban','🔻':'tri-down',
    '🧭':'compass','🗺':'map','🤖':'bot','📐':'ruler','🎨':'palette','📢':'megaphone','📣':'megaphone',
    '⏰':'clock','☕':'coffee','🎉':'sparkles','✨':'sparkles','🌟':'sparkles','💡':'bulb','🔗':'link',
    '📄':'file','⏸':'pause','🚚':'truck','🛵':'truck','❔':'help','⚖':'scale','⏻':'power',
    // semáforo: puntos de color en vez de círculos de emoji
    '🟢':'dot-ok','🟡':'dot-warn','🔴':'dot-err'
  };
  var claves = Object.keys(M).sort(function(a, b){ return b.length - a.length; });
  var RE = new RegExp('(' + claves.join('|') + ')\\uFE0F?', 'g');
  var TEST = new RegExp(claves.join('|'));

  // una regla de CSS por ícono (máscara con el dibujo; el color lo pone el texto que lo rodea)
  var css = '';
  Object.keys(P).forEach(function(k){
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + P[k] + '</svg>';
    var u = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    css += 'html[data-tema="nuevo"] .eic[data-i="' + k + '"]{-webkit-mask-image:' + u + ';mask-image:' + u + '}\n';
  });
  var st = document.createElement('style'); st.id = 'icomIconosCss'; st.textContent = css; document.head.appendChild(st);

  // contenido escrito por personas (mensajes, muro, cuerpo de correos) y selectores de emojis: se muestran tal cual
  var CONTENIDO = '.eic,.emoji-panel,.rd-emojis,.post-item-texto,.chat-burbuja,.lector-cuerpo,.fila-cuerpo,.cuerpo,.ag-cuerpo,[data-emojis-reales]';
  var SALTAR = 'SCRIPT,STYLE,TEXTAREA,OPTION,INPUT,TITLE,NOSCRIPT';
  function saltar(n){
    for(var p = n.parentNode; p && p.nodeType === 1; p = p.parentNode){
      if(SALTAR.indexOf(p.tagName) > -1 || p.isContentEditable || (p.matches && p.matches(CONTENIDO))) return true;
    }
    return false;
  }
  function procesarTexto(n){
    var t = n.nodeValue;
    if(!t || !n.parentNode || !TEST.test(t) || saltar(n)) return;
    var frag = document.createDocumentFragment(), ult = 0, m;
    RE.lastIndex = 0;
    while((m = RE.exec(t))){
      if(m.index > ult) frag.appendChild(document.createTextNode(t.slice(ult, m.index)));
      var s = document.createElement('span');
      s.className = 'eic'; s.setAttribute('data-i', M[m[1]]); s.setAttribute('aria-hidden', 'true'); s.textContent = m[0];
      frag.appendChild(s);
      ult = m.index + m[0].length;
    }
    if(ult < t.length) frag.appendChild(document.createTextNode(t.slice(ult)));
    n.parentNode.replaceChild(frag, n);
  }
  function recorrer(raiz){
    if(!raiz) return;
    if(raiz.nodeType === 3){ procesarTexto(raiz); return; }
    if(raiz.nodeType !== 1 || SALTAR.indexOf(raiz.tagName) > -1) return;
    var w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, null), lista = [], n;
    while((n = w.nextNode())) if(TEST.test(n.nodeValue)) lista.push(n);
    lista.forEach(function(x){ try{ procesarTexto(x); }catch(e){ window.__icError = String(e); } });
  }
  // setTimeout y no rAF: en pestañas en segundo plano rAF no corre
  var cola = [], prog = false;
  // La cola se procesa en tandas de ~10 ms (si hay mucho para convertir, sigue en la próxima pasada en vez de trabar la página) y, si por algún motivo gasta más de 2,5 s en total, el motor se apaga solo
  // (los emojis quedan como están: nada se rompe).
  var gastado = 0, apagado = false, obs = null;
  function procesarCola(){
    if(apagado){ cola = []; prog = false; return; }
    var t0 = performance.now(), hechos = 0;
    while(hechos < cola.length){
      var x = cola[hechos++];
      try{ if(x.isConnected) recorrer(x); }catch(e){ window.__icError = String(e); }
      if(performance.now() - t0 > 10) break;
    }
    cola = cola.slice(hechos);
    gastado += performance.now() - t0;
    if(gastado > 2500){ apagado = true; if(obs) obs.disconnect(); cola = []; prog = false; return; }
    if(cola.length){ setTimeout(procesarCola, 30); } else { prog = false; }
  }
  function programar(){ if(prog) return; prog = true; setTimeout(procesarCola, 40); }
  function iniciar(){
    recorrer(document.body);
    obs = new MutationObserver(function(muts){
      muts.forEach(function(m){
        if(m.type === 'characterData') cola.push(m.target);
        else m.addedNodes.forEach(function(x){ if(!(x.nodeType === 1 && x.classList.contains('eic'))) cola.push(x); });
      });
      if(cola.length) programar();
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  window.icomIconos = { recorrer: recorrer };
  if(document.body) iniciar(); else document.addEventListener('DOMContentLoaded', iniciar);
})();
