/** @type {import('next').NextConfig} */
const nextConfig = {
  // googleapis pulls in optional native/grpc deps that are large and
  // unused here. Stripping them keeps the serverless bundle small.
  serverExternalPackages: ['googleapis'],
};

export default nextConfig;
