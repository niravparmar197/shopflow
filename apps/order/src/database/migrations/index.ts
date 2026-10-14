// Every migration, oldest first. The webpack bundle has no .ts files for a
// glob to find, so add each new migration class here when you generate it.
import { CreateCoupons1791887902198 } from './1791887902198-CreateCoupons';
import { CreateOrders1791889015976 } from './1791889015976-CreateOrders';
import { OrderSagaInventory1791892751052 } from './1791892751052-OrderSagaInventory';
import { OrderCustomerEmail1791901816798 } from './1791901816798-OrderCustomerEmail';
import { OrderExpiry1791910154100 } from './1791910154100-OrderExpiry';
import { OrderViews1791956673352 } from './1791956673352-OrderViews';

export const MIGRATIONS = [
  CreateCoupons1791887902198,
  CreateOrders1791889015976,
  OrderSagaInventory1791892751052,
  OrderCustomerEmail1791901816798,
  OrderExpiry1791910154100,
  OrderViews1791956673352,
];
