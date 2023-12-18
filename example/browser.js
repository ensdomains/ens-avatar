const { StaticJsonRpcProvider } = require('@ethersproject/providers');
const { AvatarResolver, utils: avtUtils } = require('../dist/index');

const ensNames = [
  'achal.eth',
  'alisha.eth',
  'jefflau.eth',
  'leontalbert.eth',
  'matoken.eth',
  'nick.eth',
  'ricmoo.eth',
  'tanrikulu.eth',
  'taytems.eth',
  'validator.eth',
  'brantly.eth',
  'coinbase.eth',
  'she256.eth',
  'cory.eth',
  'avsa.eth',
  'lefteris.eth',
  'rainbowwallet.eth',
  'fireeyesdao.eth',
  'griff.eth',
];

const notFoundImage =
  'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB3aWR0aD0iMzAwcHgiIGhlaWdodD0iMzAwcHgiIHZpZXdCb3g9IjAgMCAzMDAgMzAwIiB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiPgogICAgPHRpdGxlPkdyb3VwPC90aXRsZT4KICAgIDxnIGlkPSJQYWdlLTEiIHN0cm9rZT0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIxIiBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPgogICAgICAgIDxnIGlkPSJHcm91cCI+CiAgICAgICAgICAgIDxyZWN0IGlkPSJSZWN0YW5nbGUiIGZpbGw9IiMwMDAwMDAiIHg9IjAiIHk9IjAiIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48L3JlY3Q+CiAgICAgICAgICAgIDx0ZXh0IGlkPSJDb3VsZC1ub3QtbG9hZC06KCIgZm9udC1mYW1pbHk9IlBsdXNKYWthcnRhU2Fucy1Cb2xkLCBQbHVzIEpha2FydGEgU2FucyIgZm9udC1zaXplPSIzMCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNGRkZGRkYiPgogICAgICAgICAgICAgICAgPHRzcGFuIHg9IjEwNi4wMDUiIHk9IjEyNCI+Q291bGQgPC90c3Bhbj4KICAgICAgICAgICAgICAgIDx0c3BhbiB4PSIxMjUuMjgiIHk9IjE2MiI+bm90IDwvdHNwYW4+CiAgICAgICAgICAgICAgICA8dHNwYW4geD0iMTAzLjYzNSIgeT0iMjAwIj5sb2FkIDooPC90c3Bhbj4KICAgICAgICAgICAgPC90ZXh0PgogICAgICAgIDwvZz4KICAgIDwvZz4KPC9zdmc+';
const provider = new StaticJsonRpcProvider(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const avt = new AvatarResolver(provider, {
  apiKey: { opensea: process.env.OPENSEA_KEY },
});
for (let ens of ensNames) {
  avt
    .getMetadata(ens)
    .then(metadata => {
      const avatar = avtUtils.getImageURI({
        metadata,
        gateways: { ipfs: 'https://cloudflare-ipfs.com' },
      });
      createImage(ens, avatar);
    })
    .catch(error => {
      console.warn(error);
      createImage(ens);
    });
}

function createImage(ens, avatarUri = notFoundImage) {
  const elem = document.createElement('img');
  elem.setAttribute('src', avatarUri);
  elem.setAttribute('height', '300');
  elem.setAttribute('width', '300');
  elem.setAttribute('alt', ens);
  elem.style = 'border-radius: 5px;';
  elem.style.opacity = '0';
  elem.addEventListener('load', fadeImg);
  document.getElementById('avatars').appendChild(elem);
}

function fadeImg() {
  this.style.transition = 'opacity 2s';
  this.style.opacity = '1';
}

function setImage(ens, avatarUri = notFoundImage, warn = false) {
  const elem = document.getElementById('queryImage');
  elem.setAttribute('src', avatarUri);
  elem.setAttribute('alt', ens);
  const warnText = document.getElementById('warnText');
  if (warn) {
    if (warnText) return;
    const newWarnText = document.createElement('div');
    newWarnText.id = 'warnText';
    newWarnText.textContent = 'The query is not valid';
    newWarnText.style.color = 'red';
    newWarnText.style.lineHeight = '10px';
    elem.setAttribute('height', 290);
    elem.parentNode.insertBefore(newWarnText, elem.nextSibling);
  } else {
    elem.setAttribute('height', 300);
    warnText && warnText.remove();
  }
}

document.getElementById('queryInput').addEventListener('change', event => {
  let ens = event.target.value;
  ens = ens.toLowerCase().trim();

  if (ens === 'nevergonnagiveyouup' || ens === 'rickroll') {
    setImage(
      'rickroll',
      'http://ipfs.io/ipfs/QmPmU7h1rcZkivDntjvfh8BJB5Yk32ozMjPd12HNMoAZZ8'
    );
    return;
  }

  if (ens.length < 7 || !ens.endsWith('.eth')) {
    setImage(
      'fail',
      'http://ipfs.io/ipfs/QmYVZtV4Xtbqqj6hKojgbLskf5b1rV2wNfpAwgZ2EBuQnD',
      true
    );
    return;
  }

  const elem = document.getElementById('queryImage');
  elem.style.filter = 'blur(5px) grayscale(70%)';
  elem.style.transition = 'filter .5s';
  avt
    .getMetadata(ens)
    .then(metadata => {
      const avatar = avtUtils.getImageURI({ metadata });
      setImage(ens, avatar);
      elem.style.filter = 'none';
    })
    .catch(error => {
      console.warn(error);
      setImage(ens);
      elem.style.filter = 'none';
    });
});
