import { createSupabaseClient } from "@/external/supabaseUtils.js";
import { handleBelowThresholdInvoicing } from "./invoiceThresholdUtils.js";
import { getBelowThresholdPrice } from "./invoiceThresholdUtils.js";

import {
  AllowanceType,
  AppEnv,
  CusEntWithEntitlement,
  CusProductStatus,
  Event,
  Feature,
  FullCustomerEntitlement,
  FullCustomerPrice,
  Organization,
} from "@autumn/shared";
import { CustomerEntitlementService } from "@/internal/customers/entitlements/CusEntitlementService.js";
import { Customer, FeatureType } from "@autumn/shared";
import { SupabaseClient } from "@supabase/supabase-js";
import { getCusEntsInFeatures } from "@/internal/api/customers/cusUtils.js";
import { Decimal } from "decimal.js";
import { adjustAllowance } from "./adjustAllowance.js";
import {
  getMeteredDeduction,
  getCreditSystemDeduction,
} from "./deductUtils.js";
import {
  getGroupBalanceFromEvent,
  getGroupBalanceUpdate,
  initGroupBalancesForEvent,
} from "@/internal/customers/entitlements/groupByUtils.js";
import { nullOrUndefined } from "@/utils/genUtils.js";
import { getMinCusEntBalance } from "@/internal/customers/entitlements/cusEntUtils.js";

// Decimal.set({ precision: 12 }); // 12 DP precision

type DeductParams = {
  sb: SupabaseClient;
  env: AppEnv;
  org: Organization;
  cusPrices: FullCustomerPrice[];
  customer: Customer;
  event: Event;
  feature: Feature;
};

// 2. Get deductions for each feature
const getFeatureDeductions = ({
  cusEnts,
  event,
  features,
}: {
  cusEnts: FullCustomerEntitlement[];
  event: Event;
  features: Feature[];
}) => {
  const meteredFeatures = features.filter(
    (feature) => feature.type === FeatureType.Metered
  );
  const featureDeductions = [];
  for (const feature of features) {
    let deduction;
    if (feature.type === FeatureType.Metered) {
      deduction = getMeteredDeduction(feature, event);
    } else if (feature.type === FeatureType.CreditSystem) {
      deduction = getCreditSystemDeduction({
        meteredFeatures: meteredFeatures,
        creditSystem: feature,
        event,
      });
    }

    // Check if unlimited exists
    let unlimitedExists = cusEnts.some(
      (cusEnt) => cusEnt.entitlement.allowance_type === AllowanceType.Unlimited
    );

    if (unlimitedExists || !deduction) {
      continue;
    }

    featureDeductions.push({
      feature,
      deduction,
    });
  }

  return featureDeductions;
};

const logBalanceUpdate = ({
  timeTaken,
  customer,
  features,
  cusEnts,
  featureDeductions,
  event,
  org,
}: {
  timeTaken: string;
  customer: Customer;
  features: Feature[];
  cusEnts: FullCustomerEntitlement[];
  featureDeductions: any;
  event: Event;
  org: Organization;
}) => {
  console.log(`   - getCusEntsInFeatures: ${timeTaken}ms`);
  console.log(
    `   - Customer: ${customer.id} (${customer.env}) | Org: ${
      org.slug
    } | Features: ${features.map((f) => f.id).join(", ")}`
  );
  console.log("   - Properties:", event.properties);
  console.log(
    "   - CusEnts:",
    cusEnts.map((cusEnt: any) => {
      let balanceStr = cusEnt.balance;
      let { groupVal, balance } = getGroupBalanceFromEvent({
        event,
        cusEnt,
        features,
      });

      try {
        if (cusEnt.entitlement.allowance_type === AllowanceType.Unlimited) {
          balanceStr = "Unlimited";
        } else if (groupVal) {
          balanceStr = `${balance} [${groupVal}]`;
        }
      } catch (error) {
        balanceStr = "failed_to_get_balance";
      }

      return `${cusEnt.feature_id} - ${balanceStr} (${
        cusEnt.customer_product ? cusEnt.customer_product.product_id : ""
      })`;
    }),
    "| Deductions:",
    featureDeductions.map((f: any) => `${f.feature.id}: ${f.deduction}`)
  );
};

const deductAllowanceFromCusEnt = async ({
  toDeduct,
  deductParams,
  cusEnt,
  features,
}: {
  toDeduct: number;
  deductParams: DeductParams;
  cusEnt: FullCustomerEntitlement;
  features: Feature[];
}) => {
  const { sb, feature, env, org, cusPrices, customer, event } = deductParams;

  if (toDeduct == 0) {
    return;
  }

  let newBalance, deducted;

  let cusEntBalance;
  let { groupVal, balance } = getGroupBalanceFromEvent({
    event,
    feature,
    cusEnt,
    features,
  });

  // console.log("Group val:", groupVal);
  // console.log("Balance:", balance);

  if (groupVal && nullOrUndefined(balance)) {
    console.log(
      `   - No balance found for group by value: ${groupVal}, for customer: ${customer.id}, skipping`
    );
    return toDeduct;
  }

  cusEntBalance = new Decimal(balance!);

  if (cusEntBalance.lte(0) && toDeduct > 0) {
    // Don't deduct if balance is negative and toDeduct is positive, if not, just add to balance
    return toDeduct;
  }

  // If toDeduct is negative, add to balance and set toDeduct to 0
  if (toDeduct < 0) {
    newBalance = cusEntBalance.minus(toDeduct).toNumber();
    deducted = toDeduct;
    toDeduct = 0;
  }

  // If cusEnt has less balance to deduct than 0, deduct the balance and set balance to 0
  else if (cusEntBalance.minus(toDeduct).lt(0)) {
    toDeduct = new Decimal(toDeduct).minus(cusEntBalance).toNumber(); // toDeduct = toDeduct - cusEntBalance
    deducted = cusEntBalance.toNumber(); // deducted = cusEntBalance
    newBalance = 0; // newBalance = 0
  }

  // Else, deduct the balance and set toDeduct to 0
  else {
    newBalance = cusEntBalance.minus(toDeduct).toNumber();
    deducted = toDeduct;
    toDeduct = 0;
  }

  await CustomerEntitlementService.update({
    sb,
    id: cusEnt.id,
    updates: getGroupBalanceUpdate({
      groupVal,
      cusEnt,
      newBalance,
    }),
  });

  await adjustAllowance({
    sb,
    env,
    org,
    cusPrices: cusPrices as any,
    event,
    customer,
    affectedFeature: feature,
    cusEnt: cusEnt as any,
    originalBalance: getMinCusEntBalance({ cusEnt }),
    newBalance: getMinCusEntBalance({ cusEnt, newBalance, groupVal }),
    deduction: deducted,
  });

  if (groupVal) {
    cusEnt.balances![groupVal].balance = newBalance;
  } else {
    cusEnt.balance = newBalance;
  }

  return toDeduct;
};

const deductFromUsageBasedCusEnt = async ({
  toDeduct,
  deductParams,
  cusEnts,
  features,
}: {
  toDeduct: number;
  deductParams: DeductParams;
  cusEnts: FullCustomerEntitlement[];
  features: Feature[];
}) => {
  const { sb, feature, env, org, cusPrices, customer, event } = deductParams;

  // Deduct from usage-based price
  const usageBasedEnt = cusEnts.find(
    (cusEnt: CusEntWithEntitlement) =>
      cusEnt.usage_allowed &&
      cusEnt.entitlement.internal_feature_id == feature.internal_id
  );

  if (!usageBasedEnt) {
    console.log(
      `   - Feature ${feature.id}, To deduct: ${toDeduct} -> no usage-based entitlement found`
    );
    return;
  }

  // Group by value
  let { groupVal, balance } = getGroupBalanceFromEvent({
    event,
    feature,
    cusEnt: usageBasedEnt,
  });

  if (groupVal && nullOrUndefined(balance)) {
    console.log(
      `   - Feature ${feature.id}, To deduct: ${toDeduct} -> no group balance found`
    );
    return;
  }

  let usageBasedEntBalance = new Decimal(balance!);
  let newBalance = usageBasedEntBalance.minus(toDeduct).toNumber();

  await CustomerEntitlementService.update({
    sb,
    id: usageBasedEnt.id,
    updates: getGroupBalanceUpdate({
      groupVal,
      cusEnt: usageBasedEnt,
      newBalance,
    }),
  });

  await adjustAllowance({
    sb,
    env,
    affectedFeature: feature,
    org,
    cusEnt: usageBasedEnt as any,
    cusPrices: cusPrices as any,
    event,
    customer,
    originalBalance: getMinCusEntBalance({ cusEnt: usageBasedEnt }),
    newBalance: getMinCusEntBalance({
      cusEnt: usageBasedEnt,
      newBalance,
      groupVal,
    }),
    deduction: toDeduct,
  });
};

// Main function to update customer balance
export const updateCustomerBalance = async ({
  sb,
  customer,
  event,
  features,
  org,
  env,
}: {
  sb: SupabaseClient;
  customer: Customer;
  event: Event;
  features: Feature[];
  org: Organization;
  env: AppEnv;
}) => {
  const startTime = performance.now();
  const { cusEnts, cusPrices } = await getCusEntsInFeatures({
    sb,
    internalCustomerId: customer.internal_id,
    internalFeatureIds: features.map((f) => f.internal_id!),
    inStatuses: [CusProductStatus.Active, CusProductStatus.PastDue],
    withPrices: true,
  });

  const endTime = performance.now();

  // 1. Get deductions for each feature
  const featureDeductions = getFeatureDeductions({
    cusEnts,
    event,
    features,
  });

  logBalanceUpdate({
    timeTaken: (endTime - startTime).toFixed(2),
    customer,
    features,
    cusEnts,
    featureDeductions,
    event,
    org,
  });

  // 2. Handle group_by initialization
  await initGroupBalancesForEvent({
    sb,
    features,
    cusEnts,
    properties: event.properties,
  });

  // 3. Return if no customer entitlements or features found
  if (cusEnts.length === 0 || features.length === 0) {
    console.log("   - No customer entitlements or features found");
    return;
  }

  // 4. Perform deductions and update customer balance
  for (const obj of featureDeductions) {
    let { feature, deduction: toDeduct } = obj;

    for (const cusEnt of cusEnts) {
      if (cusEnt.entitlement.internal_feature_id != feature.internal_id) {
        continue;
      }

      toDeduct = await deductAllowanceFromCusEnt({
        toDeduct,
        cusEnt,
        features,
        deductParams: {
          sb,
          feature,
          env,
          org,
          cusPrices: cusPrices as any[],
          customer,
          event,
        },
      });
    }

    if (toDeduct == 0) {
      continue;
    }

    await deductFromUsageBasedCusEnt({
      toDeduct,
      cusEnts,
      features,
      deductParams: {
        sb,
        feature,
        env,
        org,
        cusPrices: cusPrices as any[],
        customer,
        event,
      },
    });
  }

  return cusEnts;
};

// MAIN FUNCTION
export const runUpdateBalanceTask = async (payload: any) => {
  try {
    const sb = createSupabaseClient();

    // 1. Update customer balance
    const { customer, features, event, org, env } = payload;

    console.log("--------------------------------");
    console.log(
      `UPDATING BALANCE FOR CUSTOMER (${customer.id}), ORG: ${org.slug}`
    );

    console.log("1. Updating customer balance...");
    const cusEnts: any = await updateCustomerBalance({
      sb,
      customer,
      features,
      event,
      org,
      env,
    });

    if (!cusEnts || cusEnts.length === 0) {
      console.log("✅ No customer entitlements found, skipping");
      return;
    }
    console.log("   ✅ Customer balance updated");

    // 2. Check if there's below threshold price
    const belowThresholdPrice = await getBelowThresholdPrice({
      sb,
      internalCustomerId: customer.internal_id,
      cusEnts,
    });

    if (belowThresholdPrice) {
      console.log("2. Below threshold price found");

      // await new Promise((resolve) => setTimeout(resolve, 1000));

      await handleBelowThresholdInvoicing({
        sb,
        internalCustomerId: payload.internalCustomerId,
        belowThresholdPrice,
      });
    } else {
      console.log("   ✅ No below threshold price found");
    }
  } catch (error) {
    console.log(`Error updating customer balance`);
    console.log(error);
  }
};
