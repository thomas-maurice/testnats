#!/usr/bin/env python3
"""Take screenshots of the glua+NATS web UI for the README."""

import time
import json
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE_URL = "http://localhost:8080"
OUT_DIR = "screenshots"


def setup_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--force-device-scale-factor=2")
    opts.add_argument("--hide-scrollbars")
    driver = webdriver.Chrome(options=opts)
    return driver


def wait_for_output(driver, timeout=10):
    """Wait until the output panel has content (not the empty placeholder)."""
    WebDriverWait(driver, timeout).until(
        lambda d: d.find_elements(By.CSS_SELECTOR, ".output .log-line, .output .result-block, .output .error-block")
    )
    time.sleep(0.3)


def click_example(driver, name):
    """Click an example by its name in the sidebar."""
    examples = driver.find_elements(By.CSS_SELECTOR, ".sidebar .example")
    for ex in examples:
        if ex.text == name:
            ex.click()
            time.sleep(0.3)
            return
    raise ValueError(f"Example '{name}' not found")


def click_run(driver):
    """Click the Run button and wait for output."""
    btn = driver.find_element(By.CSS_SELECTOR, ".btn-run")
    btn.click()
    wait_for_output(driver)


def screenshot(driver, filename):
    """Save a screenshot."""
    path = f"{OUT_DIR}/{filename}"
    driver.save_screenshot(path)
    print(f"  saved {path}")


def main():
    driver = setup_driver()
    driver.get(BASE_URL)
    time.sleep(1)

    # 1. Landing page with Hello World loaded
    print("Taking screenshots...")
    screenshot(driver, "01_landing.png")

    # 2. Hello World executed
    click_run(driver)
    screenshot(driver, "02_hello_world.png")

    # 3. JSON Roundtrip
    click_example(driver, "JSON Roundtrip")
    click_run(driver)
    screenshot(driver, "03_json_roundtrip.png")

    # 4. K8s Resource Calculator
    click_example(driver, "K8s: Resource Calc")
    click_run(driver)
    screenshot(driver, "04_k8s_resource_calc.png")

    # 5. K8s Pod Builder
    click_example(driver, "K8s: Pod Builder")
    click_run(driver)
    screenshot(driver, "05_k8s_pod_builder.png")

    # 6. K8s Admission Policy
    click_example(driver, "K8s: Admission Policy")
    click_run(driver)
    screenshot(driver, "06_k8s_admission_policy.png")

    # 7. K8s Live Pods (if cluster is available)
    try:
        click_example(driver, "K8s: Live Pods")
        # Change namespace to kube-system for more interesting output
        vars_header = driver.find_element(By.CSS_SELECTOR, ".vars-header")
        vars_header.click()
        time.sleep(0.2)
        val_input = driver.find_element(By.CSS_SELECTOR, ".var-row input.val")
        val_input.clear()
        val_input.send_keys("kube-system")
        click_run(driver)
        screenshot(driver, "07_k8s_live_pods.png")
    except Exception as e:
        print(f"  skipping live pods: {e}")

    # 8. K8s Cluster Overview
    try:
        click_example(driver, "K8s: Cluster Overview")
        click_run(driver)
        screenshot(driver, "08_k8s_cluster_overview.png")
    except Exception as e:
        print(f"  skipping cluster overview: {e}")

    # 9. Error Demo
    click_example(driver, "Error Demo")
    click_run(driver)
    screenshot(driver, "09_error_demo.png")

    # 10. Fibonacci
    click_example(driver, "Fibonacci")
    click_run(driver)
    screenshot(driver, "10_fibonacci.png")

    driver.quit()
    print("Done!")


if __name__ == "__main__":
    main()
