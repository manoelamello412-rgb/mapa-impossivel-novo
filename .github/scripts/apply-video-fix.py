from pathlib import Path

path = Path("index.html")
html = path.read_text(encoding="utf-8")

replacements = [
    (
        "source.src=url;video.muted=true;video.defaultMuted=true;video.autoplay=true;video.playsInline=true;video.loop=true;video.removeAttribute('controls');",
        "source.src=url;video.muted=false;video.defaultMuted=false;video.autoplay=true;video.playsInline=true;video.loop=true;video.removeAttribute('controls');",
    ),
    (
        """  if (id==='experiencia') {
    const video=$('experience-video');
    video.play().then(()=>{if(current!=='experiencia')video.pause();}).catch(error=>{
      if(error.name==='NotAllowedError' && current==='experiencia'){video.muted=true;video.play().catch(()=>{});}
    });
  }
""",
        """  if (id==='experiencia') {
    const video=$('experience-video');
    video.muted=false;
    video.defaultMuted=false;
    video.removeAttribute('muted');
    video.controls=false;
    const playback=video.play();
    if(playback&&typeof playback.then==='function'){
      playback.then(()=>{if(current!=='experiencia')video.pause();}).catch(error=>{
        if(current!=='experiencia')return;
        // Não iniciar silenciosamente: se o navegador bloquear o autoplay com som,
        // disponibilizar os controles para a pessoa iniciar com áudio.
        if(error.name==='NotAllowedError'){
          video.controls=true;
          video.muted=false;
          video.setAttribute('aria-label','Toque em reproduzir para assistir com áudio');
        }else if(error.name!=='AbortError'){
          video.controls=true;
        }
      });
    }
  }
""",
    ),
    (
        '<video id="experience-video" controls muted playsinline',
        '<video id="experience-video" controls playsinline',
    ),
    (
        """  const sync=()=>{
   if(!homeVisible())return;
   iv.muted=!unlocked||otherPlaying();
  };
""",
        """  const sync=()=>{
   if(!homeVisible())return;
   iv.defaultMuted=false;
   iv.muted=!unlocked||otherPlaying();
  };
""",
    ),
    (
        """  // Não interfere nos links, botões, respostas do quiz ou formulário.
  if(event.target?.closest?.('a,button,input,select,textarea,[data-go]'))return;
""",
        """  // O gesto do usuário também pode ser o clique no botão que avança a página.
  // O listener em capture roda antes da navegação e libera o áudio nesse gesto.
""",
    ),
]

for old, new in replacements:
    count = html.count(old)
    if count != 1:
        raise SystemExit(f"Patch abortado: esperado 1 ocorrência, encontrado {count}: {old[:100]!r}")
    html = html.replace(old, new, 1)

path.write_text(html, encoding="utf-8")
print("Aplicadas 5 alterações pontuais em index.html.")
