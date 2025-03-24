module.exports = {
    apps: [
      {
        name: 'ontol-code-push-server-api',
        script: 'bin/server.js',
        instances: 1,
        exec_mode: 'cluster',
        log_date_format: 'YYYY-MM-DD HH:mm Z',
        merge_logs: true,
        env: {
          NODE_ENV: 'dev',
          dotenv_config_path: ".env",
          dotenv_config_silent: true,
        },
        wait_ready: true,
        listen_timeout: 50000,
        kill_timeout: 5000,
      },
    ],
};