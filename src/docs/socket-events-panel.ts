export const socketEventsPanelScript = `
(function () {
  var isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var textColor = isDark ? '#e4e6e6' : '#3b4151';
  var mutedColor = isDark ? '#9aa0a0' : '#999';
  var headingBorderColor = isDark ? 'rgba(255,255,255,0.15)' : '#d8d8d8';

  function el(tag, styleText, text) {
    var node = document.createElement(tag);
    if (styleText) node.style.cssText = styleText;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var BADGE_STYLE = 'display:inline-block;min-width:180px;text-align:center;padding:6px 10px;border-radius:4px;color:#fff;font-weight:700;font-size:12px;font-family:sans-serif;letter-spacing:0.5px;flex-shrink:0;';

  function buildBlock(evt) {
    var isClientToServer = evt.direction === 'client-to-server';
    var accentColor = isClientToServer ? '#49cc90' : '#61affe';
    var tintColor = isClientToServer ? 'rgba(73,204,144,.1)' : 'rgba(97,175,254,.1)';

    var block = el('div', 'border:1px solid ' + accentColor + ';border-radius:4px;margin-bottom:10px;background:' + tintColor + ';overflow:hidden;');

    var header = el('div', 'display:flex;align-items:center;gap:14px;padding:10px 16px;cursor:pointer;font-family:sans-serif;');

    var badge = el('span', BADGE_STYLE + 'background:' + accentColor + ';', isClientToServer ? 'cliente \\u2192 servidor' : 'servidor \\u2192 cliente');
    var name = el('span', 'font-family:monospace;font-weight:700;font-size:14px;color:' + textColor + ';flex-grow:1;', evt.event);
    var arrow = el('span', 'color:' + mutedColor + ';font-size:12px;', '\\u25BC');

    header.appendChild(badge);
    header.appendChild(name);
    header.appendChild(arrow);

    var body = el('div', 'display:none;padding:0 16px 16px;');

    if (evt.payloadSchema) {
      var pre = el('pre', 'margin:12px 0 0;font-size:12px;white-space:pre-wrap;background:#333;color:#e6e6e6;padding:14px;border-radius:4px;');
      pre.textContent = JSON.stringify(evt.payloadSchema, null, 2);
      body.appendChild(pre);
    } else {
      body.appendChild(el('div', 'padding-top:12px;color:' + mutedColor + ';font-size:13px;font-family:sans-serif;', 'Sem payload.'));
    }

    header.addEventListener('click', function () {
      var isOpen = body.style.display === 'block';
      body.style.display = isOpen ? 'none' : 'block';
      arrow.textContent = isOpen ? '\\u25BC' : '\\u25B2';
    });

    block.appendChild(header);
    block.appendChild(body);
    return block;
  }

  function buildSection(moduleName, moduleEvents) {
    var section = el('div', 'margin-bottom:28px;');

    var heading = el('h3', 'font-family:sans-serif;text-transform:capitalize;color:' + textColor + ';border-bottom:1px solid ' + headingBorderColor + ';padding-bottom:6px;margin-bottom:12px;', moduleName);
    section.appendChild(heading);

    moduleEvents.forEach(function (evt) {
      section.appendChild(buildBlock(evt));
    });

    return section;
  }

  window.addEventListener('load', function () {
    fetch('/docs/socket-events.json')
      .then(function (res) { return res.json(); })
      .then(function (events) {
        var wrapper = el('div', 'max-width:1460px;margin:0 auto;padding:4px 40px 40px;');

        var title = el('h2', 'font-family:sans-serif;color:' + textColor + ';margin:0 0 12px;', 'Eventos Socket.IO');
        wrapper.appendChild(title);

        var byModule = {};
        var order = [];
        events.forEach(function (evt) {
          if (!byModule[evt.module]) {
            byModule[evt.module] = [];
            order.push(evt.module);
          }
          byModule[evt.module].push(evt);
        });

        order.forEach(function (moduleName) {
          wrapper.appendChild(buildSection(moduleName, byModule[moduleName]));
        });

        var themedRoot = document.querySelector('.swagger-ui');
        if (themedRoot) {
          themedRoot.appendChild(wrapper);
        } else {
          document.body.appendChild(wrapper);
        }
      });
  });
})();
`;
