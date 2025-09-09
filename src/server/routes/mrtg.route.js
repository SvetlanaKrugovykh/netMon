const isAuthorizedGuard = require('../guards/is-authorized.guard')
const mrtgController = require('../controllers/mrtgController')
const mrtgSchema = require('../schemas/mrtg.schema')

module.exports = (fastify, _opts, done) => {

  fastify.route({
    method: 'POST',
    url: '/abonents/mrtg-report/',
    handler: mrtgController.getMrtg,
    preHandler: [
      isAuthorizedGuard
    ],
    schema: mrtgSchema
  })

  done()
}

