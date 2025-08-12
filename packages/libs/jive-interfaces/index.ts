export interface PackageTypeDef<Config> {
  create: () => string;
  deploy: (config: Config) => Promise<void>;
  build: (config: Config) => Promise<void>;
}