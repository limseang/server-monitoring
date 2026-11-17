-- Sample data for "server A" in the test lab
CREATE TABLE IF NOT EXISTS migrations (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, migration VARCHAR(255) NOT NULL, batch INT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) UNIQUE, created_at TIMESTAMP NULL);
CREATE TABLE IF NOT EXISTS products (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), price DECIMAL(10,2), stock INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED, product_id BIGINT UNSIGNED, qty INT, note TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT INTO migrations (migration, batch) VALUES ('0001_01_01_000000_create_users_table', 1), ('2026_01_01_000000_create_products_table', 1), ('2026_01_02_000000_create_orders_table', 1);
INSERT INTO users (name, email, created_at) VALUES ('Sok Dara', 'dara@example.com', NOW()), ('Chan Sreymom', 'sreymom@example.com', NOW()), ('Vannak', 'vannak@example.com', NOW());
INSERT INTO products (name, price, stock) VALUES ('Ceiling fan 56"', 45.00, 20), ('LED bulb 12W', 2.50, 500), ('Rice cooker 1.8L', 32.90, 15), ('Extension cord 5m', 6.75, 80);
INSERT INTO orders (user_id, product_id, qty, note) VALUES (1, 1, 1, 'Deliver to Toul Kork'), (2, 2, 10, 'ទិញអំពូល — unicode check ✓'), (3, 3, 1, NULL);
CREATE OR REPLACE VIEW order_totals AS SELECT o.id, p.name, o.qty * p.price AS total FROM orders o JOIN products p ON p.id = o.product_id;
