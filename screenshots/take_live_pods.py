#!/usr/bin/env python3
"""Take the live pods screenshot with default namespace."""

import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait

BASE_URL = "http://localhost:8080"


def setup_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--force-device-scale-factor=2")
    opts.add_argument("--hide-scrollbars")
    return webdriver.Chrome(options=opts)


def main():
    driver = setup_driver()
    driver.get(BASE_URL)
    time.sleep(2)

    # Click K8s: Live Pods
    examples = driver.find_elements(By.CSS_SELECTOR, ".sidebar .example")
    for ex in examples:
        if ex.text == "K8s: Live Pods":
            ex.click()
            break
    time.sleep(0.5)

    # Click Run with default namespace
    btn = driver.find_element(By.CSS_SELECTOR, ".btn-run")
    btn.click()

    # Wait for output
    WebDriverWait(driver, 15).until(
        lambda d: d.find_elements(
            By.CSS_SELECTOR,
            ".output .log-line, .output .result-block, .output .error-block",
        )
    )
    time.sleep(0.5)

    driver.save_screenshot("screenshots/07_k8s_live_pods.png")
    print("saved screenshots/07_k8s_live_pods.png")

    driver.quit()


if __name__ == "__main__":
    main()
