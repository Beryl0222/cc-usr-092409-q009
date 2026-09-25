export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = "DomainError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomainError {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ConsentError extends DomainError {
  constructor(message) {
    super(message);
    this.name = "ConsentError";
  }
}
