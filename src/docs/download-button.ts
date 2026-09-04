export const downloadButtonScript = `
(function () {
  window.addEventListener('load', function () {
    var link = document.createElement('a');
    link.href = '/docs/download';
    link.textContent = '\\u2B07 Baixar para o Postman';
    link.title = 'Baixa o OpenAPI para importar como collection no Postman';
    link.setAttribute(
      'style',
      [
        'position:fixed',
        'top:12px',
        'right:20px',
        'z-index:9999',
        'background:#49cc90',
        'color:#fff',
        'padding:8px 16px',
        'border-radius:6px',
        'text-decoration:none',
        'font-family:sans-serif',
        'font-weight:700',
        'font-size:14px',
        'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
      ].join(';'),
    );
    document.body.appendChild(link);
  });
})();
`;
