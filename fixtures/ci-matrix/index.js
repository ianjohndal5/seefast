require('fastify')().listen({ port: Number(process.env.PORT ?? 8080) });
