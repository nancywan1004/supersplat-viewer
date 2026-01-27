// proxy-server.cjs
// 这是一个独立的 Node.js 代理服务器，用于解决跨域问题
// 运行方式: npm run proxy 或 node scripts/proxy-server.cjs
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// 处理 CORS 预检请求
app.options('/proxy/cdn/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

// 代理中间件
app.use('/proxy/cdn', createProxyMiddleware({
  target: 'https://unicity-cdn.bdnrc.org.cn',
  changeOrigin: true,
  pathRewrite: { '^/proxy/cdn': '' },
  onProxyRes: (proxyRes, req, res) => {
    // 强制添加 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}));

const PORT = process.env.PROXY_PORT || 3001;
app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log('Proxy endpoint: http://localhost:' + PORT + '/proxy/cdn/*');
});
