require("source-map-support/source-map-support.js").install();

let socketPath2 = module.hot?.data?.socketPath || process.env.ELECTRON_HMR_SOCKET_PATH;

if (socketPath2 == null) {
  throw new Error(`[HMR] Env ELECTRON_HMR_SOCKET_PATH is not set`);
}

// Store `socketPath` in module.hot.data for persistence
if (module.hot) {
  module.hot.dispose((data) => {
    data.socketPath = socketPath2;
  });
}

const HmrClient2 = require("electron-webpack/out/electron-main-hmr/HmrClient").HmrClient;
new HmrClient2(socketPath2, module.hot, () => {
  return __webpack_hash__;
});