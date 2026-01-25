export default class BaseProvider {
  constructor() {
    if (new.target === BaseProvider) {
      throw new Error("BaseProvider is abstract");
    }
  }

  async execute(job, context) {
    throw new Error("execute() must be implemented by provider");
  }

  async abort(job) {
    return false;
  }
}
