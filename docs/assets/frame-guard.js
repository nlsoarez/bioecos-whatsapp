"use strict";

if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try {
    window.top.location = window.self.location;
  } catch {
    // A página permanece oculta quando o navegador bloqueia a saída do frame.
  }
}
