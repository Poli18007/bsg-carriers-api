'use strict';

// Vercel serverless entry. Every request is rewritten to this function
// (see vercel.json) and handed to the Express app, which routes it normally.
// An Express app is itself a (req, res) handler, so exporting it is enough.
module.exports = require('../app');
