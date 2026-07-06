module.exports = {
  apps: [
    {
      name: "live-shop",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};
