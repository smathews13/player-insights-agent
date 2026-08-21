export interface EnvironmentVariable {
  key: string;
  value: string;
}

export interface EnvironmentPackage {
  name: string;
  version: string;
}

export interface EnvironmentInfo {
  runtime: {
    python: string;
    node: string;
  };
  variables: EnvironmentVariable[];
  packages: EnvironmentPackage[];
}
