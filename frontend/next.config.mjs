const simulator = process.env.SIMULATOR_URL || 'http://127.0.0.1:8000';
export default {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: simulator + '/api/:path*' },
      { source: '/ws/stream', destination: simulator + '/ws/stream' },
    ];
  },
};
