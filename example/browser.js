const { StaticJsonRpcProvider } = require('@ethersproject/providers');
const { AvatarResolver, utils: avtUtils } = require('../dist/index');

const ensNames = [
  'achal.eth',
  'alisha.eth',
  'jefflau.eth',
  'matoken.eth',
  'nick.eth',
  'ricmoo.eth',
  'tanrikulu.eth',
  'taytems.eth',
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

const provider = new StaticJsonRpcProvider(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const avt = new AvatarResolver(provider);
for (let ens of ensNames) {
  avt
    .getMetadata({ ens })
    .then(metadata => {
      console.log('metadata', ens, '-',metadata)
      const avatar = avtUtils.getImageURI({ metadata });
      setImage(ens, avatar);
    })
    .catch(error => {
      console.warn(error);
      setImage(ens);
    });
}

function setImage(
  ens,
  avatarUri = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB3aWR0aD0iMzAwcHgiIGhlaWdodD0iMzAwcHgiIHZpZXdCb3g9IjAgMCAzMDAgMzAwIiB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiPgogICAgPHRpdGxlPkdyb3VwPC90aXRsZT4KICAgIDxnIGlkPSJQYWdlLTEiIHN0cm9rZT0ibm9uZSIgc3Ryb2tlLXdpZHRoPSIxIiBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPgogICAgICAgIDxnIGlkPSJHcm91cCI+CiAgICAgICAgICAgIDxyZWN0IGlkPSJSZWN0YW5nbGUiIGZpbGw9IiMwMDAwMDAiIHg9IjAiIHk9IjAiIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48L3JlY3Q+CiAgICAgICAgICAgIDx0ZXh0IGlkPSJDb3VsZC1ub3QtbG9hZC06KCIgZm9udC1mYW1pbHk9IlBsdXNKYWthcnRhU2Fucy1Cb2xkLCBQbHVzIEpha2FydGEgU2FucyIgZm9udC1zaXplPSIzMCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNGRkZGRkYiPgogICAgICAgICAgICAgICAgPHRzcGFuIHg9IjEwNi4wMDUiIHk9IjEyNCI+Q291bGQgPC90c3Bhbj4KICAgICAgICAgICAgICAgIDx0c3BhbiB4PSIxMjUuMjgiIHk9IjE2MiI+bm90IDwvdHNwYW4+CiAgICAgICAgICAgICAgICA8dHNwYW4geD0iMTAzLjYzNSIgeT0iMjAwIj5sb2FkIDooPC90c3Bhbj4KICAgICAgICAgICAgPC90ZXh0PgogICAgICAgIDwvZz4KICAgIDwvZz4KPC9zdmc+'
) {
  const elem = document.createElement('img');
  elem.setAttribute('src', avatarUri);
  elem.setAttribute('height', '300');
  elem.setAttribute('width', '300');
  elem.setAttribute('alt', ens);
  document.getElementById('avatars').appendChild(elem);
  console.log(avatarUri);
}
