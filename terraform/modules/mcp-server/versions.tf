terraform {
  # 1.6 is the floor for `import` blocks and resource `postcondition`s, both of
  # which this module and its callers rely on. Modules declare ranges; the root
  # stack pins the exact versions and commits the lock file.
  required_version = ">= 1.6.0"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = ">= 3.0.0, < 4.0.0"
    }
  }
}
