'use strict';
// ---------- the trainer's key screens ----------
// Loaded with js/keymap.js when Settings → Input → Hit keys or the drum kit's Keys button opens a key screen, so
// visitors who never change their keys don't download it.

// the trainer's other keys, named when a hit key or drum key would take one over
const SHORTCUTS = {KeyL:'Listen', KeyN:'New rhythm', KeyC:'counting on and off', KeyH:'two hands on and off', KeyM:'the learning path', KeyV:'notes or counting',
  KeyP:'your profile', Digit1:'Practice', Digit2:'Endless', Digit3:'Daily', Digit4:'Song', BracketLeft:'easier', BracketRight:'harder', ArrowUp:'faster', ArrowDown:'slower'};
function openHitKeys() {
  showModal(`<h2>Hit keys</h2><p class="muted">With one hand, every hit key plays. With two hands, Left and Right keys play that hand, and Any hand plays whichever hand has the next note.</p><div id="kmHost"></div>`, 'keys');
  Keymap.open($('#kmHost'), {targets:[{id:'any', name:'Any hand'}, {id:'left', name:'Left hand'}, {id:'right', name:'Right hand'}],
    map:hitKeyMap(), defaults:HIT_KEYS_DEFAULT, max:4, minTotal:1, noun:'hit key', warn:SHORTCUTS, warnNote:"Used as a hit key, it won't do that any more.",
    save:m => { S.hitKeys = JSON.stringify(m) === JSON.stringify(HIT_KEYS_DEFAULT) ? null : m; save(); buildHitKeys(); }, done:closeModal});
}
