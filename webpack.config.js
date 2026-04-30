/**
 * Rogue Engine webpack entry when the project root is this folder.
 * Build still resolves Assets, _Rogue, and dist relative to ./RogueEngine.
 */
const path = require("path");
const engineDir = path.join(__dirname, "RogueEngine");
process.chdir(engineDir);
module.exports = require(path.join(engineDir, "webpack.config.js"));
