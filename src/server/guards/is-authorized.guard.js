const HttpError = require('http-errors')

module.exports = function (request, _reply, done) {
  if (!request.url.includes('/redirect')) {
    if (!request.auth.clientId) {
      throw new HttpError.Unauthorized('Authorization required')
    }
  }

  done()
}
