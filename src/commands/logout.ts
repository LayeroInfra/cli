import chalk from "chalk";
import { clearConfig, configPath } from "../config.js";

export async function logoutCmd(): Promise<void> {
  await clearConfig();
  console.log(chalk.green(`logged out (removed ${configPath()})`));
}
