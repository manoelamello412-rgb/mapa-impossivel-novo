/* Modo local: eventos de rastreamento desativados; checkout e pagamentos permanecem reais. */
(function(){
 var el = document.currentScript;
 window.althea = window.althea || {visitorId: null, track: function(){}, identify: function(){}};
 window.altheaTrack = window.altheaTrack || function(){};
})();
