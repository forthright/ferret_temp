mimus = require "mimus"
util = mimus.require "./../../lib/util", __dirname, []
chai = require "./../helpers/sinon_chai"
expect = chai.expect

describe "util", ->
  # TODO: test spawn sets npm_run_path

  describe "constants", ->
    it "are defined", ->
      expect(util.API).to.eql
        COMMIT:
          FINISHED: "finished"
          PROCESSING: "processing"
          FAILED: "failed"

      expect(util.OK).to.eql "ok"

      expect(util.displayable_issues).to.eql [
        "warning"
        "style"
        "maintainability"
        "duplicate",
        "error"
        "security"
        "dependency"
      ]

      expect(util.WARN).to.eql "warning"
      expect(util.STYL).to.eql "style"
      expect(util.MAIN).to.eql "maintainability"
      expect(util.COMP).to.eql "complexity"
      expect(util.CHURN).to.eql "churn"
      expect(util.DUPE).to.eql "duplicate"
      expect(util.DEP).to.eql "dependency"

      expect(util.warnings).to.eql [
        "warning"
        "style"
        "maintainability"
        "complexity"
        "churn"
        "duplicate"
        "dependency"
      ],

      expect(util.ERR).to.eql "error"

      expect(util.errors).to.eql [
        "error"
        "security"
      ]

      expect(util.STAT).to.eql "stat"
      expect(util.GIT).to.eql "git"
      expect(util.LANG).to.eql "lang"
      expect(util.COV).to.eql "cov"

      expect(util.infos).to.eql [
        "stat"
        "git"
        "lang"
        "cov"
      ]
